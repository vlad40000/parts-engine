import Link from "next/link";
import { PageTitle } from "@/src/components/ui";
import { PrintButton } from "@/src/components/print-button";
import { CARD_CODES, INTAKE_FIELDS, NOTE_STATUSES } from "@/src/lib/tech-notes/vocabulary";

/**
 * Roadrunner Standardized Field Intake (RR-F1): two half-sheet forms per letter page, one machine
 * per form, solid black text and lines, open writing space. The reader also still reads the old
 * RR-M1 / RR-R1 cards and free handwritten notes; those are no longer printed here.
 */
function IntakeForm() {
  return (
    <div className="rf-form">
      <div className="rf-head">
        <span className="rf-title">ROADRUNNER STANDARDIZED FIELD INTAKE</span>
        <span className="rf-code">{CARD_CODES.intake}</span>
      </div>
      <div className="rf-row">
        <div className="rf-field rf-machine"><span className="rf-label">{INTAKE_FIELDS[0]}</span><div className="rf-space" /></div>
        <div className="rf-field rf-date"><span className="rf-label">{INTAKE_FIELDS[1]}</span><div className="rf-space" /></div>
      </div>
      <div className="rf-field"><span className="rf-label">{INTAKE_FIELDS[2]}</span><div className="rf-space" /></div>
      <div className="rf-field">
        <span className="rf-label">{INTAKE_FIELDS[3]}</span><div className="rf-space" />
        <span className="rf-ref">Fleet statuses: {NOTE_STATUSES.filter((s) => s.status !== "UNCHECKED").map((s) => s.status).join(" · ")}</span>
      </div>
      <div className="rf-field rf-notes"><span className="rf-label">{INTAKE_FIELDS[4]}</span><div className="rf-space" /></div>
      <p className="rf-foot">
        One machine per form. In Notes, write what is wrong and each part as: needs, bad, missing, check, replaced from #, took for #.
        &quot;Ready for clean&quot; goes in Notes. Cross out mistakes with one line. No customer names or phone numbers.
      </p>
    </div>
  );
}

export default function IntakeFormPage() {
  return (
    <>
      <div className="no-print">
        <PageTitle
          title="Field intake forms"
          sub={<>
            <Link className="text-accent underline" href="/notes">Tech notes</Link> · Roadrunner Standardized Field Intake ({CARD_CODES.intake}).
            Print on letter paper at 100% (Actual size) and cut on the center line: two half-sheet forms per page, one machine per form.
            The old Status/Move and Repair cards and free handwritten notes are still read.
          </>}
        />
        <div className="mb-4 flex flex-wrap items-center gap-2"><PrintButton /></div>
      </div>
      <div className="rr-sheet-wrap">
        <div className="rr-sheet rf-sheet">
          <IntakeForm />
          <IntakeForm />
        </div>
      </div>
    </>
  );
}
