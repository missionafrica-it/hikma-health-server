import { Kysely, sql } from "kysely";

/**
 * Migration: Auto-generate sequential external_patient_id values
 * Created at: 2026-04-14
 * Description:
 *   Creates a DB sequence (patient_external_id_seq) and a BEFORE INSERT trigger
 *   that populates external_patient_id with "P00001", "P00002", … whenever a patient
 *   is inserted without one.
 *
 *   Existing patients with a NULL external_patient_id are backfilled in the same
 *   migration, ordered by created_at so older patients get lower numbers.
 *
 *   The trigger intentionally skips rows that already have a non-empty value, so
 *   callers that supply their own external_patient_id (e.g. bulk import) are unaffected.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // 1. Create the sequence
  await sql`CREATE SEQUENCE IF NOT EXISTS patient_external_id_seq START 1`.execute(db);

  // 2. Create the trigger function
  await sql`
    CREATE OR REPLACE FUNCTION set_patient_external_id()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.external_patient_id IS NULL OR TRIM(NEW.external_patient_id) = '' THEN
        NEW.external_patient_id := 'P' || LPAD(nextval('patient_external_id_seq')::text, 5, '0');
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  // 3. Attach the trigger to the patients table
  await sql`
    CREATE TRIGGER trg_set_patient_external_id
      BEFORE INSERT ON patients
      FOR EACH ROW
      EXECUTE FUNCTION set_patient_external_id();
  `.execute(db);

  // 4. Backfill existing patients that have no external_patient_id, oldest first.
  //    PostgreSQL does not support ORDER BY in UPDATE directly, so use a CTE to
  //    drive the update in created_at order.
  await sql`
    WITH ordered AS (
      SELECT id
      FROM patients
      WHERE external_patient_id IS NULL OR TRIM(COALESCE(external_patient_id, '')) = ''
      ORDER BY created_at ASC NULLS LAST
    )
    UPDATE patients
    SET external_patient_id = 'P' || LPAD(nextval('patient_external_id_seq')::text, 5, '0')
    FROM ordered
    WHERE patients.id = ordered.id;
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_set_patient_external_id ON patients`.execute(db);
  await sql`DROP FUNCTION IF EXISTS set_patient_external_id()`.execute(db);
  await sql`DROP SEQUENCE IF EXISTS patient_external_id_seq`.execute(db);
}
