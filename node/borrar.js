var git=require('nodegit');
var repo;

git.Clone("https://github.com/agmoyano/test.git",'borrar', {
	bare: 1,
	remoteCallbacks: {
    certificateCheck: function() {
      // github will fail cert check on some OSX machines
      // this overrides that check
      return 1;
    }
  }
}).then(function(repository) {
	repo = repository;
	return repo.fetchAll({
    credentials: function(url, userName) {
      return git.Cred.sshKeyFromAgent(userName);
    },
    certificateCheck: function() {
      return 1;
    }
  });
}).then(function() {
		console.log(arguments);
    return repo.mergeBranches("master", "origin/master");
  })
	.catch(function(err) {
		console.log(err);
	})
  .done(function() {
    console.log("Done!");
  });
