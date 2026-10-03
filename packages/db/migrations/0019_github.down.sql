DELETE FROM entity WHERE type = 'github_pr';
DROP TABLE github_pr;
DROP TABLE github_repo;
DROP TABLE github_account;
DELETE FROM principal WHERE id = 'integration:github';
