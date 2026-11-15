INSERT INTO categories(id,name,position,hidden)
VALUES('category-12','Рапорт ГДП',12,0) ON CONFLICT(id) DO NOTHING;
INSERT INTO recurring_rules(id,category_id,title,cadence,ready_day,placement_day,topic,topic_locked,item_count)
VALUES('weekly-gdp-report','category-12','Рапорт ГДП','weekly',1,1,'',0,0)
ON CONFLICT(id) DO NOTHING;
-- Preserve the catch-up checkpoint while including the new rule immediately.
INSERT INTO meta(key,value) VALUES('recurring_rules_changed','true')
ON CONFLICT(key) DO UPDATE SET value=excluded.value;
PRAGMA user_version=4;
