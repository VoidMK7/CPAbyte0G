-- HillsByte Proof Management Service
-- Run this in the Supabase SQL editor.
-- The service uses the Supabase service-role key on the server only.

create extension if not exists pgcrypto;

create table if not exists users (
  telegram_id text primary key,
  full_name text,
  username text,
  profile_image_url text,
  main_app_user_id text,
  registration_info jsonb not null default '{}'::jsonb,
  cached_main_app_profile jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists proof_submissions (
  id uuid primary key default gen_random_uuid(),
  submission_id text not null unique,
  user_telegram_id text not null references users(telegram_id) on update cascade,
  user_name text,
  username text,
  task_id text not null,
  task_name text not null,
  task_description text,
  task_metadata jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  screenshot_path text not null,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  reject_reason_type text,
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rejected_reason_type_check check (
    status <> 'rejected' or reject_reason_type is not null
  )
);

create index if not exists proof_submissions_status_idx on proof_submissions(status);
create index if not exists proof_submissions_user_idx on proof_submissions(user_telegram_id);
create index if not exists proof_submissions_task_idx on proof_submissions(task_id);
create index if not exists proof_submissions_submitted_idx on proof_submissions(submitted_at desc);

create table if not exists proof_metadata (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references proof_submissions(id) on delete cascade,
  key text not null,
  value jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists proof_metadata_submission_idx on proof_metadata(submission_id);

create table if not exists proof_reviews (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references proof_submissions(id) on delete cascade,
  reviewer_telegram_id text not null,
  action text not null check (action in ('approved','rejected')),
  reject_reason_type text,
  reject_reason text,
  reviewed_at timestamptz not null default now()
);

create index if not exists proof_reviews_submission_idx on proof_reviews(submission_id);

create table if not exists moderators (
  telegram_id text primary key,
  full_name text,
  username text,
  role text not null default 'MODERATOR' check (role in ('OWNER','MODERATOR')),
  added_by text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists broadcasts (
  id uuid primary key default gen_random_uuid(),
  created_by text not null,
  message text not null,
  target_type text not null check (target_type in ('all','selected','task')),
  target_data jsonb not null default '{}'::jsonb,
  total_targets integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists admin_messages (
  id uuid primary key default gen_random_uuid(),
  user_telegram_id text not null references users(telegram_id) on update cascade,
  admin_telegram_id text not null,
  message text not null,
  delivery_status text not null default 'pending',
  telegram_message_id bigint,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_telegram_id text not null,
  action text not null,
  target text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_updated_at on users;
create trigger users_updated_at before update on users for each row execute function set_updated_at();

drop trigger if exists proofs_updated_at on proof_submissions;
create trigger proofs_updated_at before update on proof_submissions for each row execute function set_updated_at();

drop trigger if exists moderators_updated_at on moderators;
create trigger moderators_updated_at before update on moderators for each row execute function set_updated_at();

-- Keep tables inaccessible through the anon/authenticated PostgREST roles.
-- The Node server uses the service-role key.
alter table users enable row level security;
alter table proof_submissions enable row level security;
alter table proof_metadata enable row level security;
alter table proof_reviews enable row level security;
alter table moderators enable row level security;
alter table broadcasts enable row level security;
alter table admin_messages enable row level security;
alter table audit_logs enable row level security;

-- Storage bucket. Create as private.
insert into storage.buckets (id, name, public)
values ('task-proofs', 'task-proofs', false)
on conflict (id) do update set public = false;

-- Storage policies intentionally do not grant public access.
-- Server-side service role bypasses RLS for upload/delete/signing.
