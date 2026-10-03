-- People and companies (M5). A person keeps the company they work at, how often you want to be
-- in touch, and fields you add; a company is known by its web domain. Events remember whether
-- their guests have been linked to people, so events synced before this get linked once.
CREATE TABLE company (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  domain text NOT NULL UNIQUE
);

CREATE TABLE person (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  company_id uuid REFERENCES entity (id) ON DELETE SET NULL,
  follow_up_days integer CHECK (follow_up_days BETWEEN 1 AND 3650),
  fields jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX person_company ON person (company_id);

ALTER TABLE calendar_event ADD COLUMN people_linked boolean NOT NULL DEFAULT false;
