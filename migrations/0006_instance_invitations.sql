-- Instance invitations (Admin → Users): an invitation can bring someone into a new workspace of their own
-- (workspace_id NULL, new_workspace_name) and can make them an instance admin. SQLite cannot drop NOT NULL in place,
-- so the (small) table is rebuilt.
CREATE TABLE invitations_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  email TEXT,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  new_workspace_name TEXT,
  instance_admin INTEGER NOT NULL DEFAULT 0
);
INSERT INTO invitations_new (id, workspace_id, email, role, token_hash, created_by, created_at, expires_at, accepted_at)
  SELECT id, workspace_id, email, role, token_hash, created_by, created_at, expires_at, accepted_at FROM invitations;
DROP TABLE invitations;
ALTER TABLE invitations_new RENAME TO invitations;
CREATE INDEX idx_invitations_ws ON invitations(workspace_id);
