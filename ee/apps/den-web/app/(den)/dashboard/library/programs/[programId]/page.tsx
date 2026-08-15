import { ProgramDetailScreen } from "../../../_components/program-detail-screen";

export default async function ProgramPage({ params }: { params: Promise<{ programId: string }> }) {
  const { programId } = await params;
  return <ProgramDetailScreen programId={programId} />;
}
