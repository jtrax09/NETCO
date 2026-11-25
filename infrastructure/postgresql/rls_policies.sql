-- TRAX LINK — PostgreSQL Row-Level Security (RLS) Policies for Multi-Tenant Isolation
-- Apply after Prisma schema migrations. Application requests set:
--   SET LOCAL app.current_tenant_id = '<business_id>';
--   SET LOCAL app.is_super_admin = 'false';

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'Location',
    'Customer',
    'Package',
    'Voucher',
    'Session',
    'Payment',
    'Router',
    'Subscription',
    'ProvisioningJob',
    'RadCheck',
    'RadReply',
    'RadAcct',
    'Notification',
    'AuditLog'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON %I USING ("businessId" = current_setting(''app.current_tenant_id'', true) OR current_setting(''app.is_super_admin'', true) = ''true'') WITH CHECK ("businessId" = current_setting(''app.current_tenant_id'', true) OR current_setting(''app.is_super_admin'', true) = ''true'');',
      t
    );
  END LOOP;
END $$;
