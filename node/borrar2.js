var git=require('nodegit');
var repo;

git.Repository.open('borrar').then(function(repository) {
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
  .done(function() {
		console.log(arguments);
    console.log("Done!");
  });
