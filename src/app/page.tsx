import { getAzureConfigStatus } from "@/lib/config";
import { ProfileWorkspace } from "@/components/profile-workspace";

export default function Home() {
  return <ProfileWorkspace config={getAzureConfigStatus()} />;
}
