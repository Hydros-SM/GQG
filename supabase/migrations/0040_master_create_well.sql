-- ============================================================================
-- 0040. Мастер сам создаёт задания на бурение (14.10.2026).
-- Могут: роль «Ответственный» (party_chief) с должностью уровня 4 и профилем
-- «бурение». Скважина создаётся сразу в работе, бригадир — сам мастер.
-- Править и удалять свою созданную скважину можно, пока по ней нет
-- согласованных сводок. Чужие и запланированные начальством скважины мастер
-- не меняет (их он только запускает, см. 0034).
-- ============================================================================

create or replace function can_master_create_well()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles p
    join positions pos on pos.id = p.position_id
    where p.id = auth.uid() and p.role = 'party_chief'
      and pos.level = 4 and pos.work_area = 'drilling'
  );
$$;

create or replace function master_can_edit_well(p_task uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select can_master_create_well()
    and exists (select 1 from drilling_tasks dt where dt.id = p_task and dt.foreman_id = auth.uid() and dt.created_by = auth.uid())
    and not exists (select 1 from reports r where r.drilling_task_id = p_task and r.approval_status = 'approved');
$$;

grant execute on function can_master_create_well() to authenticated;
grant execute on function master_can_edit_well(uuid) to authenticated;

-- мастер видит список участков, чтобы выбрать, где создать скважину
drop policy if exists "sites_select_master_create" on sites;
create policy "sites_select_master_create" on sites for select using (can_master_create_well());

drop policy if exists "drilling_tasks_insert_master" on drilling_tasks;
create policy "drilling_tasks_insert_master" on drilling_tasks for insert
  with check (
    can_master_create_well()
    and foreman_id = auth.uid()
    and created_by = auth.uid()
    and status = 'in_progress'
  );

drop policy if exists "drilling_tasks_update_master" on drilling_tasks;
create policy "drilling_tasks_update_master" on drilling_tasks for update
  using (master_can_edit_well(id))
  with check (foreman_id = auth.uid() and created_by = auth.uid());

drop policy if exists "drilling_tasks_delete_master" on drilling_tasks;
create policy "drilling_tasks_delete_master" on drilling_tasks for delete
  using (master_can_edit_well(id));

drop policy if exists "drilling_task_diameters_write_master" on drilling_task_diameters;
create policy "drilling_task_diameters_write_master" on drilling_task_diameters for all
  using (master_can_edit_well(drilling_task_id))
  with check (master_can_edit_well(drilling_task_id));
