-- Keep legacy user IDs and the users table intact. Custom role assignments are
-- separate; existing WORKER/CHIEF users inherit their original permissions.
CREATE TABLE roles (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, permissions TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0)
);
CREATE TABLE user_roles (
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 role_id TEXT NOT NULL REFERENCES roles(id)
);
INSERT INTO roles VALUES
('WORKER','Работник','["documents.create","documents.edit","documents.delete","documents.ready","documents.place","documents.return","history.view","reviews.view"]',1),
('CHIEF','Начальник','["documents.create","documents.edit","documents.delete","documents.ready","documents.place","documents.return","history.view","reviews.view","documents.confirm","reviews.create","schedule.manage"]',1);
PRAGMA user_version=8;
