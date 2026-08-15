import { RemoteMcpAppDetailScreen } from "../../_components/remote-mcp-app-detail-screen";

export default async function RemoteMcpAppPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = await params;
  return <RemoteMcpAppDetailScreen appId={appId} />;
}
