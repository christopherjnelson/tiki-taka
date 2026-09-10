-- A pre-existing dashboard-created event trigger may call one or more overloads
-- of this function. Keep that event trigger untouched, but remove every direct
-- SQL entry point granted by PostgreSQL's default PUBLIC EXECUTE privilege.
-- Event triggers retain their stored function OID and migrations run as postgres,
-- whose privileges are not revoked here. A clean local database has no matching
-- routines, so the loop is safely a no-op.
do $$
declare
  function_signature regprocedure;
begin
  for function_signature in
    select procedures.oid::regprocedure
    from pg_proc as procedures
    join pg_namespace as namespaces on namespaces.oid = procedures.pronamespace
    where namespaces.nspname = 'public'
      and procedures.proname = 'rls_auto_enable'
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated, service_role',
      function_signature
    );
  end loop;
end;
$$;
