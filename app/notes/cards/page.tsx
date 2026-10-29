import { redirect } from "next/navigation";

/** Serve the owner's approved half-sheet PDF unchanged. Informal notes use the same reader. */
export default function IntakeFormPage() {
  redirect("/forms/roadrunner-machine-service-update.pdf");
}
