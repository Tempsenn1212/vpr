CREATE TABLE document_comments (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 document_id TEXT NOT NULL REFERENCES documents(id),
 author_id TEXT NOT NULL REFERENCES users(id),
 author_name TEXT NOT NULL,
 at TEXT NOT NULL,
 text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 2000)
);
CREATE INDEX comments_document ON document_comments(document_id,seq);
PRAGMA user_version=6;
