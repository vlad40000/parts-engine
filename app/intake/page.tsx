import { hasDatabase } from "@/src/db";
import { NoDatabase, PageTitle } from "@/src/components/ui";
import { MachineForm, UploadForm } from "@/src/components/forms";
import { addMachineAction, importFleetAction } from "../actions";

export const dynamic = "force-dynamic";

export default function IntakePage() {
  if (!hasDatabase()) return <NoDatabase />;
  return (
    <>
      <PageTitle
        title="Intake"
        sub="Import the inventory workbook or the numbered intake sheets, or add one machine. Machine IDs and model text are kept exactly as entered. Purchaser name, address and phone columns are never read."
      />
      <section className="card mb-5 p-4">
        <h2 className="mb-1 font-semibold">Import a sheet</h2>
        <p className="mb-3 text-xs text-muted">
          .xlsx or .csv with ID / No. / Machine ID, Brand, Model and Serial. Re-importing updates machines with the same ID.
          Every serial is decoded to all its possible build years; failure symptoms in Diagnosis / Repair Notes become part-family flags.
        </p>
        <UploadForm action={importFleetAction} label="Import" accept=".xlsx,.csv" />
      </section>
      <section className="card p-4">
        <h2 className="mb-3 font-semibold">Add one machine</h2>
        <MachineForm action={addMachineAction} />
      </section>
    </>
  );
}
