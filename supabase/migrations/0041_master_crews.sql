-- ============================================================================
-- 0041. «Моя бригада» мастера и защита от двойного назначения (14.10.2026).
--  * crews / crew_members — бригады мастера: до 2 на мастера, состав по сменам
--    (буровик + помощник в смену 1 и 2, роль по должности работника).
--  * Работник состоит только в одной бригаде (unique) и только на одной
--    скважине в работе: триггер на task_worker_assignments (жёсткий запрет).
--  * Пока на скважине нет состава бригады, мастер не может подать по ней сводку
--    (restrictive-политика на reports, начальство не ограничивается).
--  * apply_crew_to_well — поставить готовую бригаду на скважину.
-- ============================================================================

create table if not exists crews (
  id uuid primary key default gen_random_uuid(),
  master_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  drilling_task_id uuid references drilling_tasks(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists crews_task_uniq on crews (drilling_task_id) where drilling_task_id is not null;

create table if not exists crew_members (
  id uuid primary key default gen_random_uuid(),
  crew_id uuid not null references crews(id) on delete cascade,
  worker_id uuid not null references workers(id) on delete cascade,
  role text not null check (role in ('driller', 'assistant_driller')),
  shift_number smallint not null check (shift_number in (1, 2)),
  unique (worker_id)
);

alter table crews enable row level security;
alter table crew_members enable row level security;

drop policy if exists "crews_own_or_management" on crews;
create policy "crews_own_or_management" on crews for all
  using (is_management() or (master_id = auth.uid() and is_party_chief()))
  with check (is_management() or (master_id = auth.uid() and is_party_chief()));

drop policy if exists "crew_members_own_or_management" on crew_members;
create policy "crew_members_own_or_management" on crew_members for all
  using (exists (select 1 from crews c where c.id = crew_members.crew_id and (is_management() or (c.master_id = auth.uid() and is_party_chief()))))
  with check (exists (select 1 from crews c where c.id = crew_members.crew_id and (is_management() or (c.master_id = auth.uid() and is_party_chief()))));

-- не больше двух бригад у мастера
create or replace function crews_limit_check()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from crews where master_id = new.master_id) >= 2 then
    raise exception 'У мастера может быть не больше двух бригад';
  end if;
  return new;
end;
$$;
drop trigger if exists crews_limit_trg on crews;
create trigger crews_limit_trg before insert on crews for each row execute function crews_limit_check();

-- проверка состава бригады
create or replace function crew_members_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cm uuid;
  ct uuid;
  w workers%rowtype;
  crew_role_of text;
  busy text;
begin
  select master_id, drilling_task_id into cm, ct from crews where id = new.crew_id;
  select * into w from workers where id = new.worker_id and archived_at is null;
  if not found then
    raise exception 'Работник не найден или в архиве';
  end if;
  if w.assigned_foreman_id is not null and w.assigned_foreman_id <> cm then
    raise exception 'Работник % числится в бригаде другого мастера', w.full_name;
  end if;
  select pos.crew_role into crew_role_of from positions pos where pos.id = w.position_id;
  if crew_role_of is distinct from new.role then
    raise exception 'Должность работника % не подходит для выбранной роли', w.full_name;
  end if;
  select t.well_number into busy
  from task_worker_assignments a join drilling_tasks t on t.id = a.drilling_task_id
  where a.worker_id = new.worker_id and a.valid_to is null
    and a.role in ('driller', 'assistant_driller')
    and t.status in ('in_progress', 'suspended')
    and t.id is distinct from ct
  limit 1;
  if busy is not null then
    raise exception 'Работник % уже работает на скважине №%', w.full_name, busy;
  end if;
  if w.assigned_foreman_id is null then
    perform set_config('app.transfer_reason', 'состав бригады мастера', true);
    update workers set assigned_foreman_id = cm where id = w.id;
  end if;
  return new;
end;
$$;
drop trigger if exists crew_members_check_trg on crew_members;
create trigger crew_members_check_trg before insert or update on crew_members for each row execute function crew_members_check();

-- жёсткий запрет: работник — одна скважина в работе
create or replace function twa_no_double_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  busy text;
  wname text;
begin
  if new.role not in ('driller', 'assistant_driller') or new.valid_to is not null or new.drilling_task_id is null then
    return new;
  end if;
  select t.well_number into busy
  from task_worker_assignments a join drilling_tasks t on t.id = a.drilling_task_id
  where a.worker_id = new.worker_id and a.valid_to is null
    and a.role in ('driller', 'assistant_driller')
    and a.id <> new.id
    and t.status in ('in_progress', 'suspended')
  limit 1;
  if busy is not null then
    select full_name into wname from workers where id = new.worker_id;
    raise exception 'Работник % уже в составе бригады на скважине №%: сначала снимите его оттуда', wname, busy;
  end if;
  return new;
end;
$$;
drop trigger if exists twa_no_double_assignment_trg on task_worker_assignments;
create trigger twa_no_double_assignment_trg before insert or update on task_worker_assignments for each row execute function twa_no_double_assignment();

-- есть ли на скважине состав бригады
create or replace function well_has_crew(p_task uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from task_worker_assignments a
    where a.drilling_task_id = p_task and a.valid_to is null and a.role in ('driller', 'assistant_driller')
  );
$$;
grant execute on function well_has_crew(uuid) to authenticated;

-- сводку по бурению нельзя подать, пока не составлена бригада
drop policy if exists "reports_insert_crew_required" on reports;
create policy "reports_insert_crew_required" on reports as restrictive for insert
  with check (drilling_task_id is null or is_management() or well_has_crew(drilling_task_id));

-- поставить готовую бригаду на скважину
create or replace function apply_crew_to_well(p_crew uuid, p_task uuid, p_date date default current_date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  c crews%rowtype;
  t drilling_tasks%rowtype;
  m record;
  n int := 0;
  nd int := 0;
  na int := 0;
  oth text;
begin
  select * into c from crews where id = p_crew;
  if not found then raise exception 'Бригада не найдена'; end if;
  if not is_management() and c.master_id <> me then
    raise exception 'Это бригада другого мастера' using errcode = '42501';
  end if;
  select * into t from drilling_tasks where id = p_task;
  if not found then raise exception 'Скважина не найдена'; end if;
  if t.foreman_id is distinct from c.master_id then
    raise exception 'Скважина должна принадлежать мастеру бригады';
  end if;
  if t.status not in ('in_progress', 'suspended') then
    raise exception 'Бригаду можно поставить только на скважину в работе';
  end if;
  if well_has_crew(p_task) then
    raise exception 'На скважине уже есть состав бригады — меняйте его в «Составе бригады» скважины';
  end if;
  if c.drilling_task_id is not null and c.drilling_task_id <> p_task then
    select t2.well_number into oth from drilling_tasks t2 where t2.id = c.drilling_task_id and t2.status in ('in_progress', 'suspended');
    if oth is not null then
      raise exception 'Бригада уже работает на скважине №%', oth;
    end if;
  end if;
  for m in select * from crew_members where crew_id = p_crew loop
    n := n + 1;
    if m.role = 'driller' then nd := nd + 1; else na := na + 1; end if;
  end loop;
  if nd = 0 or na = 0 then
    raise exception 'В бригаде нужен хотя бы один машинист-буровик и один помощник';
  end if;
  for m in select * from crew_members where crew_id = p_crew loop
    insert into task_worker_assignments (drilling_task_id, role, worker_id, shift_number, valid_from)
    values (p_task, m.role, m.worker_id, m.shift_number, p_date);
  end loop;
  update crews set drilling_task_id = p_task where id = p_crew;
  return jsonb_build_object('task', p_task, 'members', n);
end;
$$;
grant execute on function apply_crew_to_well(uuid, uuid, date) to authenticated;
