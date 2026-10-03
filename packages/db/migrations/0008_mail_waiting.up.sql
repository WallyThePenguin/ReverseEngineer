-- Who a conversation is waiting on (M2): "you" when the last message is a person writing to you
-- and needs an answer, "them" when you wrote last. You can say a conversation needs no reply,
-- which holds until another message arrives (no_reply_count is how many there were then). nudged_at is when Jarvis last drafted a follow-up.
ALTER TABLE mail_thread
  ADD COLUMN waiting text,
  ADD COLUMN waiting_since timestamptz,
  ADD COLUMN no_reply_count integer,
  ADD COLUMN nudged_at timestamptz;

-- Mail already here, by the same rule the code uses (flags.ts waitingOn), from each conversation's
-- last message (the last one not in the trash, if there is one).
UPDATE mail_thread t SET waiting = x.waiting, waiting_since = x.sent_at
FROM (
  SELECT DISTINCT ON (m.thread_id)
    m.thread_id,
    m.sent_at,
    CASE
      WHEN m.outbound AND 'SENT' = ANY (m.labels) THEN 'them'
      WHEN th.lane = 'signal'
        AND m.from_address !~* '^(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|bounces?|alerts?|news(letter)?|updates?|info|hello|support|billing|receipts?|orders?|team|marketing)([+._-][^@]*)?@'
        AND NOT EXISTS (
          SELECT 1 FROM unnest(m.labels) l
          WHERE l LIKE 'CATEGORY\_%' AND l <> 'CATEGORY_PERSONAL'
        )
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(m.to_addresses) e
          WHERE lower(e ->> 'address') = lower(a.address)
        )
        THEN 'you'
    END AS waiting
  FROM mail_message m
  JOIN mail_thread th ON th.entity_id = m.thread_id
  JOIN mail_account a ON a.id = th.account_id
  ORDER BY m.thread_id, ('TRASH' = ANY (m.labels)), m.sent_at DESC
) x
WHERE x.thread_id = t.entity_id;
