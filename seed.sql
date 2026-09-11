insert into schools (name, short_name, region) values
  ('Bloom Academy, Port of Spain', 'Port of Spain', 'Port of Spain'),
  ('Bloom Academy, San Fernando', 'San Fernando', 'San Fernando'),
  ('Bloom Academy, Arima', 'Arima', 'Tunapuna–Piarco'),
  ('Bloom Academy, Chaguanas', 'Chaguanas', 'Chaguanas'),
  ('Bloom Academy, Scarborough', 'Scarborough', 'Tobago');
-- Replace with the real five schools before launch.

insert into perks (id, partner, offer, detail, cost, terms, valid_days, active) values
  ('starbucks', 'Starbucks Trinidad & Tobago', 'Staffroom Friday', '20% off handcrafted drinks for your whole staff on one Friday of your choice.', 30,
   'Valid at participating Starbucks stores in Trinidad and Tobago. Show the code with school ID at the counter. One redemption per school per term; not combinable with other offers.', 90, false),
  ('rik', 'R.I.K. Services', 'Classroom books & stationery', '10% off books, stationery and classroom supplies at any RIK branch.', 20,
   'Valid at RIK branches nationwide for school purchases. Show the code at checkout. Excludes textbooks under the Ministry rental programme.', 90, false),
  ('tecu', 'TECU Credit Union', 'Staff financial-wellness session', 'A free 45-minute on-site session on budgeting, saving and education loans for your staff.', 40,
   'Booked directly with TECU using the code. Subject to availability; membership information provided but not required to attend.', 90, false);
-- Set active = true only when the partner agreement is signed. The client stays in "Term 2 preview" while no perk is active.

-- Profiles are created after the users exist in auth.users (invite via dashboard or admin API), e.g.:
-- insert into profiles (user_id, email, school_id, role) values ('<uuid>', 'principal.pos@bloom.tt', (select id from schools where short_name='Port of Spain'), 'principal');
-- insert into profiles (user_id, email, role) values ('<uuid>', 'central@cebm.tt', 'central');
