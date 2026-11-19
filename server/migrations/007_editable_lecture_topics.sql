-- A constant default for new Tuesday plans; other lecture types start empty.
UPDATE recurring_rules SET
 topic=CASE WHEN id='inform-tuesday' THEN 'Военно-политическая (общественно-политическая) обстановка, государственная политика в области обеспечения обороны и военной безопасности Российской Федерации, место и роль Вооруженных Сил Российской Федерации в системе национальной безопасности.' ELSE '' END,
 topic_locked=0,
 version=version+1
WHERE category_id='category-6' AND (
 topic_locked<>0 OR topic<>CASE WHEN id='inform-tuesday' THEN 'Военно-политическая (общественно-политическая) обстановка, государственная политика в области обеспечения обороны и военной безопасности Российской Федерации, место и роль Вооруженных Сил Российской Федерации в системе национальной безопасности.' ELSE '' END
);
-- Unlock the technical flag without changing topics, dates, user marks or
-- document content versions. Historical audit and review snapshots are kept.
UPDATE documents SET data=json_set(data,'$.recurring.topicLocked',json('false'))
WHERE category_id='category-6' AND json_extract(data,'$.recurring.topicLocked')=1;
PRAGMA user_version=7;
