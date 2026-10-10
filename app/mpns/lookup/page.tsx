import { redirect } from "next/navigation";

export default async function MpnLookup({ searchParams }: { searchParams: Promise<{ mpn?: string }> }) {
  const { mpn } = await searchParams;
  const value = mpn?.trim();
  if (!value) redirect("/mpns");
  redirect(`/mpns/${encodeURIComponent(value)}?availability=eligible`);
}
