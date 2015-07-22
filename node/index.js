var express = require('express');
var app = express();
var git = require('nodegit');
var http = require('nodegit-http');
var redis = require('redis');
var fs = require('fs-extra');
var crypto = require('crypto');
var extend = require('extend');
var config = JSON.parse(fs.readFileSync('config.json'));
var async = require('async');
var path = require('path');
var Promise = require("promise");


var cdnPath =  path.join('/opt','cdn')
var reposPath = path.join(cdnPath, 'repos');
var nginxPath = path.join(cdnPath, 'nginx');
var ngSitesPath = path.join(nginxPath, 'sites');
var ngCertsPath = path.join(nginxPath, 'certs');
var ngConfPath = path.join(nginxPath, 'conf.d');
var ngLogPath = path.join(nginxPath, 'log');
var ngHtmlPath = path.join(nginxPath, 'html');
var ngCachePath = path.join(nginxPath, 'cache');
var ngGeoipPath = path.join(nginxPath, 'geoip');

if(!config.org || !config.org.name) {
  console.log('No organization name found');
  process.exit();
}

try {
  [reposPath, ngSitesPath, ngCertsPath, ngConfPath, ngLogPath, ngHtmlPath, ngCachePath, ngGeoipPath].forEach(fs.ensureDirSync);
} catch(e) {
  console.log('Could not create necesary directory structure.');
  process.exit();
}

try {
  var idFile = path.join(cdnPath, 'id');
  fs.ensureFileSync(idFile);
  var id = config.id||fs.readFileSync(idFile).ToString()||rypto.createHash('md5').update(config.org.name+Math.random()+new Date().getTime()).digest('hex');
  fs.writeFileSync(idFile, id);
} catch(e) {
  console.log('Could not read/create id file.');
  process.exit();
}

var channel = redis.createClient(config.redis);
var rc = redis.createClient(config.redis);

if(config.redis.hasOwnProperty('db')) {
  channel.select(config.redis.db);
  rc.select(config.redis.db);
}

rc.sadd('cdn:orgs', config.org.name);
/*fs.ensureDir(path.join(reposPath, org), function(err) {
  console.log('Could not create orgs repo directory structure.');
  process.exit();
});*/

var iRepos = function(org, iterator, done) {
  rc.smembers('cdn:'+org+':repos', function (err, repos) {
    if(err) return done(err);
    async.each(repos, iterator, done);
  });
};

var iOrgs = function(iterator, done) {
  rc.smembers('cdn:orgs', function(err, orgs) {
    if(err) return done(err);
    async.each(orgs, iterator, done);
  });
}

var pullRepo = function(repo, done) {
  return repo.fetchAll({
    credentials: function(url, userName) {
      return git.Cred.sshKeyFromAgent(userName);
    },
    certificateCheck: function() {
      return 1;
    }
  })
  .then(function() {
    return getBranches(repo);
  })
  .then(function(branches) {
    var promises = [];
    repo.getRemotes()
    .then(function (remotes) {
      remotes.forEach(function (remote) {
        branches.forEach(function(branch) {
          promises.push(repo.mergeBranches(branch, remote+"/"+branch));
        });
      });
    });
    return Promise.all(promises);
  })
  .then(function() {
    done();
  })
  .catch(done);
}

var openRepo = function(ops) {
  return git.Repository.openBare(path.join(reposPath, ops.project));
};

var getBranches = function(repo) {
  return repo.getReferences().then(function(refs) {
    return refs.filter(function(ref) {
      return ref.isBranch();
    });
  });
}

var updateProject = function(ops, done) {
  openRepo(ops).then(function(repo) {
    pullRepo(repo, done);
  })
  .catch(done);
};

var doCloning = function(ops, done) {
  var dir = ops.dest||path.join(reposPath, ops.project);
  fs.emptyDir(dir,function(err) {
    if(err) return done(err);
    git.Clone(ops.url, dir, {
      bare: ops.bare||1,
      remoteCallbacks: {
        certificateCheck: function() {
          // github will fail cert check on some OSX machines
          // this overrides that check
          return 1;
        }
      }
    })
    .then(function(repo) {
      done(null, repo);
    })
    .catch(done);
  });
};

var cloneProject = function(ops, done) {
  rc.get('cdn:'+ops.org+':repo:'+ops.project, function(err, url){
    if(err) return done(err);
    ops.url = url;
    doCloning(ops, done);
  });
};

var createProject = function(ops, done) {
  rc.set('cdn:'+ops.org+':repo:'+ops.project, ops.url, function(err){
    if(err) return done(err);
    doCloning(ops, done);
  });
};

var getVersionCommit = function(ops, done) {
  rc.get(id+':cdn:'+ops.org+':repo:'+ops.project+':'+ops.version, function(err, commit){
    if(err) return done(err);
    done(null, commit);
  });
};

var setVersionCommit = function(ops, done) {
  rc.set(id+':cdn:'+ops.org+':repo:'+ops.project+':'+ops.version, ops.commit, function(err){
    if(err) return done(err);
    done();
  });
};

var cloneOrUpdate = function(ops, done) {
  updateProject(ops, function(err) {
    if(err) {
      cloneProject(ops, done);
    } else {
      done();
    }
  });
};

var minify = function(org, project, done) {

}

//Initialize Repositories
async.waterfall([
  function(cb) {
    //clone or update local repos..
    iRepos(config.org.name,function (repo, cb) {
      fs.ensureDir(path.join(reposPath, repo), function(err) {
        if(err) return cb(err);
        cloneOrUpdate({org: config.org.name, project: repo}, cb);
      });
    }, cb);
  },
  function(cb) {
    iOrgs(function(org, cb) {
      fs.ensureDir(path.join(ngSitesPath, org), function(err) {
        if(err) return cb(err);
        iRepos(org, function(project, cb) {
          fs.ensureDir(path.join(ngSitesPath, org, project), function(err) {
            if(err) return cb(err);
            //Ver todos los branches que se llamen al estilo version_<num> o v<num>
            var p;
            if(org == config.org.name) {
              p = openRepo({project: project});
            } else {
              p = new Promise(function(resolve, reject) {
                cloneProject({org: org, project: project, dest: path.join('/tmp', org, project)}, function(err, repo) {
                  if(err) return reject(err);
                  resolve(repo);
                })
              });
            }
            var repo;

              p.then(function(r) {
                repo = r;
                return getBranches(r);
              })
              .then(function(branches) {
                //Filtrar los branches que se llamen 'version_<num>, version <num>, version<num>, v_<num>, v <num> o v<num>'
                var promises = branches
                  .map(function(branch) {
                     return branch.name().match(/v(?:ersion)?(?:_| )?([0-9][.0-9]*)/);
                  })
                  .filter(function(match) {
                    return match;
                  })
                  .map(function(version) {
                    //Obtener el último commit de cada branch
                    return new Promise(function(resolve, reject) {
                      repo.getBranchCommit(version[0])
                        .then(function(commit) {
                          resolve({name: version[0], num: version[1], commit: {repo: commit});
                        })
                        .catch(reject);
                    })
                    .then(function(version) {
                      //Ver si existe el directorio
                      fs.stat(path.join(ngSitesPath, org, project, 'v'+version.num), function(err, stat) {
                        version.hasDir = stat&&stat.isDirectory();
                        resolve(version);
                      });
                    })
                    .then(function(version) {
                      //Obtengo el ultimo commit guardado en redis
                      return new Promise(function(resolve, reject) {
                        getVersionCommit({org: org, project: project, version: version.num}, function (err, commit) {
                          if(err) return reject(err);
                          version.commit.redis = commit;
                          resolve(version);
                        })
                      });
                    });
                  });
                if(!promises.length) return Promise.reject('No branches to work with.');
                return Promise.all(promises);
              })
              .then(function(versions) {
                //por cada version comparar si esta al dia
                return versions.filter(function(version) {
                  return !version.hasDir || version.commit.repo.toString() != version.commit.redis;
                });
              })
              .then(function(versions) {
                if(!versions.length) return Promise.reject('Nothing to do.');

                var promises = versions.forEach(function(version) {
                  //Por cada branch a trabajar, recorrer los directorios (menos .git, bower_components y node_modules) buscando javascripts, css o imagenes
                  return new Promise(function(resolve, reject) {
                    //Creo o vacío el directorio
                    fs.emptyDir(path.join(ngSitesPath, org, project, 'v'+version.num), function(err) {
                      if(err) return reject(err);
                      //Obtengo el arbol del branch
                      version.commit.repo.getTree()
                      .then(function(tree) {
                        //Si se encuentran javascripts, css o imagenes, replicar la estructura de directorio en ngSitesPath y minificar
                      })

                      //Si se encuentra una referencia simbolica 'LATEST', hacer un link simbólico apuntando al branch correspondiente.. caso contrario a la última versión.

                      //Si se encuentra una referencia simbolica 'STABLE', 'TEST' o 'DEV' hacer un link simbólico apuntando al branch correspondiente.

                      //Guardar en redis cual es el último commit del branch
                    });
                  });
                });
              });
              //eliminar repo en tmp
          });
        }, cb);
      });
    }, cb);
  }
], function (e) {
  if(e) {
    console.log(e.message);
    process.exit();
  }
});


var nodes = {};
var me = {ip: config.ip, port: config.port};
channel.on('subscribe', function(name, count) {
  if(name == 'cdn:nodes') {
    //I'm new.. publish to channel that I exist
    channel.publish('cdn:nodes', {from: id, type: 'present', node: me});
    /*setInterval(function(){
      channel.publish('cdn:nodes', {from: id, type: 'heartbeat'});
    }, 1000);*/
  }
});

channel.on('message', function(name, message) {
  if(name == 'cdn:nodes') {
    switch (message.type) {
      case 'present':
        //There's a new node, send data
        nodes[message.from] = message.node;
        channel.publish('cdn:'+message.from, {from: id, type: 're:present', node: me});
        break;
    }
  } else {
    switch (message.type) {
      case 're:present':
        //some node sent data, save it
        nodes[message.from] = message.node;
        break;

    }
  }
});

channel.subscribe('cdn:'+id);
channel.subscribe('cdn:nodes');




app.get('/', function(req, res,next) {
  res.send('hola');
});



app.listen(config.port);
