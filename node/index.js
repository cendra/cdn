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
var mime = require('mime-sniffer');
var lookup = Promise.denodeify(mime.lookup);
var UglifyJS = require("uglify-js");
var CleanCSS = require('clean-css');
var util = require('util');
var rendy = require('rendy');
var request = require('request');
var io = require('socket.io')(app, { serveClient: false });
var ioc = require('socket.io-client');


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

var sockets = {};

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

var setOrg = function(org, cb) {
  return new Promise(function(resolve, reject) {
    rc.sadd('cdn:orgs', org.name);
    rc.hmset('cdn:'+org.name, org);
    resolve();
  })
  .nodeify(cb);
}


var getOrg = function(name, cb) {
  return new Promise(function(resolve, reject) {
    rc.hgetall('cdn:'+name, function(err, org) {
      if(err) return reject(err);
      resolve(org);
    });
  })
  .nodeify(cb);
}

setOrg(config.org);

/*fs.ensureDir(path.join(reposPath, org), function(err) {
  console.log('Could not create orgs repo directory structure.');
  process.exit();
});*/

var iRepos = function(org, iterator, done) {
  rc.smembers('cdn:'+org+':projs', function (err, repos) {
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

var getSymbolic = function(repo) {
  return repo.getReferences().then(function(refs) {
    return refs.filter(function(ref) {
      return ref.isSymbolic();
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
  rc.get('cdn:'+ops.org+':proj:'+ops.project, function(err, url){
    if(err) return done(err);
    ops.url = url;
    doCloning(ops, done);
  });
};

var createProject = function(ops, done) {
  rc.sadd('cdn:'+ops.org+':projs', ops.project.name, function(err) {
    if(err) return done(err);
    if(!ops.project.private) {
      rc.sadd('cdn:'+ops.org+':projs:public', ops.project.name);
    } else {
      rc.sdel('cdn:'+ops.org+':projs:public', ops.project.name);
    }
    rc.hmset('cdn:'+ops.org+':proj:'+ops.project.name, ops.project, function(err){
      if(err) return done(err);
      ops.url = ops.project.url;
      ops.project = ops.project.name;
      doCloning(ops, done);
    });
  })
};

var getVersionCommit = function(ops, done) {
  rc.get(id+':cdn:'+ops.org+':proj:'+ops.project+':'+ops.version, function(err, commit){
    if(err) return done(err);
    done(null, commit);
  });
};

var setVersionCommit = function(ops, done) {
  rc.set(id+':cdn:'+ops.org+':proj:'+ops.project+':'+ops.version, ops.commit, function(err){
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

var createProjectRepo = function(org, project, cb) {
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
                  resolve({name: version[0], num: version[1], commit: {repo: commit}});
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

        return Promise.all(versions.forEach(function(version) {
          //Por cada branch a trabajar, recorrer los directorios (menos .git, bower_components y node_modules) buscando javascripts, css o imagenes
          return new Promise(function(resolve, reject) {
            //Creo o vacío el directorio
            fs.emptyDir(path.join(ngSitesPath, org, project, 'v'+version.num), function(err) {
              if(err) return reject(err);

              resolve(
                //Obtengo el arbol del branch
                version.commit.repo.getTree()
                .then(function(tree) {
                  var treeWalk = function(tree) {
                    return Promise.all(tree.entries().map(function(entry) {
                      entryName = path.filename(entry.path());
                      if(entry.isBlob()) {
                        if(/.+\.js$/.test(entryName)) {
                          var min = UglifyJS.minify(entry.getBlob().content().toString(), {fromString: true});
                          return Promise.resolve({path: entry.path(), min: min.code});
                        } else if (/.+\.css$/.test(entryName)) {
                          var min = new CleanCSS().minify(entry.getBlob().content().toString());
                          return Promise.resolve({path: entry.path(), min: min.styles});
                        } else if (/.+\.svg$/.test(entryName)) {
                          return new Promise(function(resolve, reject) {
                            new Imagemin()
                              .src(entry.getBlob().content())
                              .use(Imagemin.svgo())
                              .run(function(err, files) {
                                if(err) return reject(err);
                                resolve({path: entry.path(), min: files[0].contents});
                              });
                          });
                        } else {
                          return lookup(entry.getBlob().content())
                                  .then(function(info) {
                                    m = info.mime.match(/image\/(jpeg|png|gif)/.test());
                                    if(!m[1]) return Promise({path: entry.path(), min: entry.getBlob().content()});
                                    var middleware;
                                    switch(m[1]) {
                                      case 'jpeg':
                                        middleware = Imagemin.jpegtran({progressive: true});
                                        break;
                                      case 'png':
                                        middleware = Imagemin.optipng({optimizationLevel: 3});
                                        break;
                                      case 'gif':
                                        middleware = Imagemin.gifsicle({interlaced: true});
                                        break;
                                    }
                                    return new Promise(function(resolve, reject) {
                                      new Imagemin()
                                        .src(entry.getBlob().content())
                                        .use(middleware)
                                        .run(function(err, files) {
                                          if(err) return reject(err);
                                          resolve({path: entry.path(), min: files[0].contents});
                                        });
                                    });
                                  })
                                  .catch(function(err) {
                                    return Promise.resolve(null);
                                  });
                        }
                      } else {
                        if(entryName != '.git' && entryName != 'node_modules' && entryName != 'bower_components') return treeWalk(entry);
                        return Promise.resolve(null);
                      }
                    }))
                    .then(function(results) {
                      var r = results.filter(function(result) {
                        return result;
                      });
                      return r.length?r:null;
                    });
                  };

                  return treeWalk(tree)
                    .then(function(filesTree) {
                      var walkFiles = function(tree) {
                        var files = [];
                        tree.forEach(function(entry) {
                          if(!entry) return;
                          if(util.isArray(entry)) {
                            files = files.concat(walkFiles(entry));
                          }
                          files.push(entry);
                        });
                        return files;
                      };
                      return walkFiles(filesTree);
                    });
                  //Si se encuentran javascripts, css o imagenes, replicar la estructura de directorio en ngSitesPath y minificar
                })
                .then(function(files) {
                  if(!files || !files.length) return Promise.resolve();
                  return Promise.all(files.map(function(file) {
                    return new Promise(function(resolve, reject) {
                      fs.outputFile(path.join(ngSitesPath, org, project, 'v'+version.num, file.path), file.min, function(err) {
                        if(err) return reject(err);
                        resolve();
                      });
                    });
                  }));
                });
              );


            });
          })
          .then(function() {
            return new Promise(function(resolve, reject) {
              //Guardar en redis cual es el último commit del branch
              setVersionCommit({org: org, project: project, version: version.num, commit: version.commit.repo.toString()}, function(err) {
                if(err) return reject(err);
                resolve(versions);
              });
            });
          });
        }));
      })
      .then(function(versions) {
        !versions.length && return;
        var max = 0;
        var numsRegExps = versions.map(function(version) {
          if(version.num > max) {
            max = version.num;
          }
          return {reg: new RegExp('v(?:ersion)?(?:_| )?'+version.num+'$'), num: version.num};
        })

        //Crear las configuraciones correspondientes para nginx
        return getSymbolic(repo).then(function(symbolics) {
          var hasLatest = false;
          symbolics.forEach(function(symbolic) {
            //Se agrega una configuracion por cada referencia simbolica que se llame PUBLIC_<nombre>
            var target = symbolic.symbolicTarget();
            var version = numsRegExps.filter(function(version) {
              return version.reg.test(target);
            });
            if(!version.length) return;
            var name = symbolic.name().toLowerCase().match(/^public_(.+)$/);
            if(!name) return;
            name[1] == 'latest' && (hasLatest = true);
            fs.outputFileSync(path.join(ngConfPath, 'locations', org+'-'+project+'-'+name[1]+'.conf'), rendy(fs.readFileSync('nginx-location-template.conf').toString(), {
              rule: '/'+org+'/'+project+'/'+name[1],
              root: path.join(ngSitesPath, org, project, 'v'+version[0].num);
            }));
          });
          if(!hasLatest) {
            fs.outputFileSync(path.join(ngConfPath, 'locations', org+'-'+project+'-latest.conf'), rendy(fs.readFileSync('nginx-location-template.conf').toString(), {
              rule: '/'+org+'/'+project+'/latest',
              root: path.join(ngSitesPath, org, project, 'v'+max);
            }));
          }
        });
        //Si se encuentra una referencia simbolica 'LATEST', hacer una config de nginx apuntando al branch correspondiente.. caso contrario a la última versión.

      });
      .then(function() {
        if(org != config.org.name) {
          fs.remove(path.join('/tmp', org, project));
        }
        return Promise.resolve();
      })
      .nodeify(cb);
  });
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
        if(org != config.org.name) {
          getOrg(org).then(function(org){
            if(org.url) {
              sockets[org.name] = ioc(org.url);
            }
          });
        }
        iRepos(org, function(project, cb) {
          createProjectRepo(org, project, cb);
        }, cb);
      });
    }, function(err) {
      if(err) return cb(err);
      var conf = rendy(fs.readFileSync('nginx-template.conf').toString(), {
        root: ngSitesPath
      });
      fs.outputFileSync(path.join(ngConfPath, 'cdn.conf'), conf);
      cb();
    });
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
      case 'newOrg':
        getOrg(message.org, function(err, org) {
          sockets[org.name] = ioc(org.url);
        });
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


var checkUser = function(req, res, next) {
  //Validate user somehow

  next();
}

var checkOrg = function(socket, next) {
  //Validate org somehow
  next();
}

var checkAtts = function(atts) {
  !util.isArray(atts) && (atts = [atts]);
  return function(req, res, next) {
    var noAtts = [];
    atts.forEach(function(att) {
      if(!req.body[att] && !req.params[att] && !req.query[att]) {
        noAtts.push(att);
      }
    });
    if(hasAtts.length) {
      var last = hasAtts.pop();
      var msg = (hasAtts.length?hasAtts.join(', ')+' and ':'')+last;
      return res.status(400).send('Required '+msg+' attribute'+(hasAtts.length?'s are':' is')+' missing.');
    }
    next();
  }
}

/*======= API =======*/

var api = express.Router('/api');

api.use(checkUser);

/****** ORGANIZACIONES *******/

api.get('/org', function(req, res, next) {
  rc.smembers('cdn:orgs', function(err, orgs) {
    if(err) return res.status(500).send(err);
    res.json(orgs);
  });
})

//agregar una nueva organizacion
api.post('/org', checkAtts('url'), function(req, res, next) {

  var md5 = crypto.createHash('md5').update(config.org.name+req.body.url+(new Date().toISOString())+Math.random()).digest('hex');

  request.post({
    url: req.body.url+'/cdn/connect/'+md5,
    form: config.org
  }, function(err, response, body) {
    if(err) return res.status(response.statusCode).send(body);
    if(response.statusCode == 202) {
      rc.sadd('cdn:pending', md5);
      rc.set('cdn:pending:'+md5, req.body.url);
      res.status(202).send(md5);
    } else {
      body = JSON.parse(body)
      setOrg(body).then(function() {
        sockets[org.name] = ioc(body.url);
        channel.publish('cdn:nodes', {org: body.name});
      });


      res.send('ok');
    }
  })
});

//get list of orgs connections to approve
api.get('/org/approve', function(req, res, next) {
  rc.smembers('cdn:approve', function(err, md5s) {
    var orgs = {};
    async.each(md5s, function(md5, cb) {
      rc.hgetall('cdn:approve:'+md5, function(err, org) {
        if(err) return cb(err);
        orgs[md5] = org;
        cb();
      })
    }, function(err) {
      if(err) return res.status(500).send(err);
      res.json(orgs);
    });
  });
});

//set approved orgs
api.put('/org/approve', checkAtts('orgs') function(req, res, next) {
  res.status(202).send('ok');
  for(var md5 in req.body.orgs) {
    rc.sdel('cdn:approve', md5);
    rc.hgetall('cdn:approve:'+md5, function(err, org) {
      rc.del('cdn:approve:'+md5);
      var options = {url: org.url+'/cdn/pending/'+md5};
      if(req.body.orgs[md5]) {
        setOrg(org).then(function() {
          sockets[org.name] = ioc(org.url);
          channel.publish('cdn:nodes', {org: org.name});
        });
        options.method = 'POST';
        options.form = config.org;
      } else {
        options.method = 'DELETE'
      }
      request(options);
    });
  }
});

/******* PROYECTOS ********/

//Listado de proyectos
api.get('/org/:org/project', function(req, res, next) {
  var projects = {};
  if(req.params.org == config.org.name) {
    rc.smembers('cdn:'+config.org.name+':projs', function(err, projs) {
      if(err) return res.status(500).send(err);
      async.each(projs, function(proj, cb) {
        rc.hgetall('cdn:'+config.org.name+':proj:'+proj, function (err, obj) {
          projects[proj] = err?{}:obj;
          cb();
        })
      }, function(err) {
        res.json(projects);
      });
    });
  } else {
    rc.sismember('cdn:orgs', req.params.org, function(err, member) {
      if(err) return res.status(500).send(err);
      if(!member) return res.status(404).send('Organization with name '+req.params.org+' not found.');
      rc.hgetall('cdn:'+req.params.org, function(err, org) {
        if(err||!org||!org.url||!sockets[org.name]) return res.status(500).send(err||'Organization with name '+req.params.org+' not found.');
        sockets[org.name].emit('org:projects', function(err, projects) {
          if(err) return res.status(500).send('External organization '+req.params.org+' had problems delyvering projects.');
          res.json(projects);
        });
      });
    });
  }
});

/*======= CDN =======*/
var cdn = express.Router('/cdn');

//Receive connection from org
cdn.post('/connect/:md5', function(req, res, next) {
  if(config.cdn && config.cdn.accept == 'all') {
    setOrg(req.body);
    res.json(config.org);
  } else {
    rc.sadd('cdn:approve', req.params.md5);
    rc.hmset('cdn:approve:'+req.params.md5, req.body);
    res.status(202).send('ok');
  }
});

//Set pending org connection
cdn.all('/pending/:md5', function(req, res, next) {
  var method = req.method.toLowerCase();
  if(['post', 'delete'].indexOf(method) == -1) return res.status(400).send('Invalid method '+req.method);
  res.status(202).send('ok');
  rc.sismember('cdn:pending', req.params.md5, function(err, member) {
    if(member) {
      rc.sdel('cdn:pending', req.params.md5);
      rc.get('cdn:pending:'+req.params.md5, function(err, url) {
        rc.del('cdn:pending:'+req.params.md5);
        if(err||method == 'delete') return;
        setOrg(org).then(function() {
          sockets[org.name] = ioc(org.url);
          channel.publish('cdn:nodes', {org: org.name});
        });
      });
    }
  });
});

io.use(checkOrg);

io.on('connection', function(socket) {
  socket.on('org:projects', function(cb) {
    rc.smembers('cdn:'+config.org.name+':projs', function(err, projs) {
      if(err) return cb(err);
      async.each(projs, function(proj, cb) {
        rc.hgetall('cdn:'+config.org.name+':proj:'+proj, function (err, obj) {
          projects[proj] = err?{}:obj;
          cb();
        })
      }, function(err) {
        cb(null, projects);
      });
    });
  });
})


//cdn.del('/pending/:md5', function(req, res, next) {});

app.get('/', function(req, res,next) {
  res.send('hola');
});



app.listen(config.port);
