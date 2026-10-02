import React, { useEffect, useState } from "react";
import { default as WorkspaceChatContainer } from "@/components/WorkspaceChat";
import Sidebar from "@/components/Sidebar";
import { useParams } from "react-router-dom";
import Workspace from "@/models/workspace";
import PasswordModal, { usePasswordModal } from "@/components/Modals/Password";
import { isMobile } from "react-device-detect";
import { FullScreenLoader } from "@/components/Preloader";
import { LAST_VISITED_WORKSPACE } from "@/utils/constants";

export default function WorkspaceChat() {
  const { loading, requiresAuth, mode } = usePasswordModal();

  if (loading) return <FullScreenLoader />;
  if (requiresAuth !== false) {
    return <>{requiresAuth !== null && <PasswordModal mode={mode} />}</>;
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-zinc-950 light:bg-slate-50 flex">
      {!isMobile && <Sidebar />}
      <ShowWorkspaceChat />
    </div>
  );
}

function ShowWorkspaceChat() {
  const { slug } = useParams();
  const [workspace, setWorkspace] = useState(null);
  // Tracks which workspace `workspace` belongs to. While a new workspace's
  // data is in flight, we keep the previous workspace's chat mounted
  // (Slack/Linear-style transition) instead of flashing a skeleton.
  const [loadedSlug, setLoadedSlug] = useState(null);

  useEffect(() => {
    async function getWorkspace() {
      if (!slug) return;
      try {
        const _workspace = await Workspace.bySlug(slug);
        if (!_workspace) {
          setWorkspace(null);
          setLoadedSlug(slug);
          return;
        }

        const [suggestedMessages, agentStatus] = await Promise.allSettled([
          Workspace.getSuggestedMessages(slug),
          Workspace.agentCommandAvailable(slug),
        ]);

        setWorkspace({
          ..._workspace,
          suggestedMessages:
            suggestedMessages.status === "fulfilled"
              ? suggestedMessages.value
              : [],
          showAgentCommand:
            agentStatus.status === "fulfilled"
              ? agentStatus.value?.showAgentCommand
              : false,
        });
        setLoadedSlug(slug);
        localStorage.setItem(
          LAST_VISITED_WORKSPACE,
          JSON.stringify({
            slug: _workspace.slug,
            name: _workspace.name,
          })
        );
      } catch (error) {
        console.error("Failed to load workspace:", error);
        setLoadedSlug(slug);
      }
    }
    getWorkspace();
  }, [slug]);

  return (
    <WorkspaceChatContainer
      loading={loadedSlug !== slug}
      workspace={workspace}
    />
  );
}
