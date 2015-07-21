# deploy
`deploy` is a great ansible playbook.

# Setup
`gem install librarian-ansible`
`librarian-ansible install`

# Usage
## Development (if you used `--vagrant` flag: `vagrant up`
When you make changes, run `vagrant provision` to update your vms.
## Production
`ansible-playbook -i production site.yml`
