-- Normalize only the four standard headings in category 6. Custom headings,
-- marks, topics, occurrence keys and historical snapshots are kept.
CREATE TEMP TABLE vpr_plan_titles(old_title TEXT PRIMARY KEY, new_title TEXT NOT NULL);
INSERT INTO vpr_plan_titles VALUES
('ПЛАН ПРОВЕДЕНИЯ ВОЕННО-ПОЛИТИЧЕСКОГО ИНФОРМИРОВАНИЯ', 'План проведения военно-политического информирования'),
('ПЛАН ПРОВЕДЕНИЯ ВОЕННО-ПОЛИТИЧЕСКОЙ РАБОТЫ В ВЕЧЕРНЕЕ ВРЕМЯ', 'План проведения военно-политической работы в вечернее время'),
('ПЛАН ПРОВЕДЕНИЯ ВОСКРЕСНОГО ЛЕКТОРИЯ', 'План проведения воскресного лектория'),
('ПЛАН ПРОВЕДЕНИЯ ЕДИНОГО ДНЯ ИНФОРМИРОВАНИЯ', 'План проведения единого дня информирования');

UPDATE recurring_rules SET
 title=(SELECT new_title FROM vpr_plan_titles WHERE old_title=recurring_rules.title),
 version=version+1
WHERE category_id='category-6' AND title IN (SELECT old_title FROM vpr_plan_titles);

CREATE TEMP TABLE vpr_title_changes AS
SELECT d.id, d.data AS before_data,
 json_set(d.data,
   '$.title', t.new_title || substr(json_extract(d.data, '$.title'), length(t.old_title)+1),
   '$.version', d.version+1,
   '$.updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS after_data
FROM documents d JOIN vpr_plan_titles t
 ON json_extract(d.data, '$.title')=t.old_title
 OR substr(json_extract(d.data, '$.title'), 1, length(t.old_title)+3)=t.old_title || ' · '
WHERE d.category_id='category-6' AND d.deleted=0;

UPDATE documents SET
 data=(SELECT after_data FROM vpr_title_changes WHERE id=documents.id),
 version=version+1
WHERE id IN (SELECT id FROM vpr_title_changes);

-- System renaming is audited without inventing participant marks.
INSERT INTO audit_events(id,document_id,actor_id,actor_name,type,at,data)
SELECT lower(hex(randomblob(16))), id, 'system-scheduler', 'Автоматический учёт',
 'RENAME', json_extract(after_data, '$.updatedAt'),
 json_object('before',json(before_data),'after',json(after_data),
   'reason','Типовое название плана приведено к обычному регистру',
   'categoryNames',json((SELECT json_group_object(id,name) FROM categories)))
FROM vpr_title_changes;

DROP TABLE vpr_title_changes;
DROP TABLE vpr_plan_titles;
PRAGMA user_version=5;
