INSERT INTO users(id,telegram_id,name,role,admin,active)
VALUES('system-scheduler','system-scheduler','Автоматический учёт','WORKER',0,0);
CREATE TABLE recurring_rules (
 id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES categories(id),
 title TEXT NOT NULL, cadence TEXT NOT NULL, ready_day INTEGER NOT NULL,
 placement_day INTEGER NOT NULL, topic TEXT NOT NULL DEFAULT '',
 topic_locked INTEGER NOT NULL DEFAULT 0, item_count INTEGER NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE recurring_occurrences (
 rule_id TEXT NOT NULL REFERENCES recurring_rules(id), period_key TEXT NOT NULL,
 document_id TEXT NOT NULL UNIQUE REFERENCES documents(id),
 PRIMARY KEY(rule_id,period_key)
);
-- Weekly day numbers start at Monday=1. 0 means the end of the ready-date month.
-- Monthly day 31 is clamped to the actual end of the month.
INSERT INTO recurring_rules(id,category_id,title,cadence,ready_day,placement_day,topic,topic_locked,item_count) VALUES
('monthly-vpr','category-1','План военно-политической работы на месяц','monthly',25,31,'',0,0),
('quarterly-meeting','category-4','Протокол собрания военнослужащих роты','quarterly',31,31,'',0,0),
('weekly-summary','category-5','Материалы подведения итогов','weekly',5,7,'',0,0),
('inform-tuesday','category-6','ПЛАН ПРОВЕДЕНИЯ ВОЕННО-ПОЛИТИЧЕСКОГО ИНФОРМИРОВАНИЯ','weekly',2,0,'Военно-политическая (общественно-политическая) обстановка, государственная политика в области обеспечения обороны и военной безопасности Российской Федерации, место и роль Вооруженных Сил Российской Федерации в системе национальной безопасности.',1,0),
('evening-friday','category-6','ПЛАН ПРОВЕДЕНИЯ ВОЕННО-ПОЛИТИЧЕСКОЙ РАБОТЫ В ВЕЧЕРНЕЕ ВРЕМЯ','weekly',5,0,'',0,0),
('lecture-sunday','category-6','ПЛАН ПРОВЕДЕНИЯ ВОСКРЕСНОГО ЛЕКТОРИЯ','weekly',7,0,'',0,0),
('information-day','category-6','ПЛАН ПРОВЕДЕНИЯ ЕДИНОГО ДНЯ ИНФОРМИРОВАНИЯ','monthly',31,31,'',0,0),
('monthly-conversations','category-9','Лист беседы','monthly',31,31,'',0,40),
('callup-files','category-10','Личные дела военнослужащих','callup',31,31,'',0,0),
('weekly-battle','category-11','Боевой листок','weekly',6,13,'',0,0);
PRAGMA user_version=3;
