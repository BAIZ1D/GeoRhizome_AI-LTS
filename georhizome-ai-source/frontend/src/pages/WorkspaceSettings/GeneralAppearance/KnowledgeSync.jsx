import React, { useState } from "react";
import showToast from "@/utils/toast";

export default function KnowledgeSync({ workspace }) {
  const [syncing, setSyncing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [wiping, setWiping] = useState(false);
  
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showWipeModal, setShowWipeModal] = useState(false);
  const [githubPat, setGithubPat] = useState("");

  const handleSync = async () => {
    setSyncing(true);
    showToast("同期を開始しました。お待ちください...", "info", { clear: true });
    try {
      const response = await fetch("/api/system/sync-workspace", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${window.localStorage.getItem("anythingllm_authToken")}`
        },
        body: JSON.stringify({ slug: workspace.slug })
      });
      
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to sync workspace");
      
      showToast("同期が完了しました。", "success", { clear: true });
      setTimeout(() => window.location.reload(), 2000);
    } catch (e) {
      console.error(e);
      showToast(`同期エラー: ${e.message}`, "error", { clear: true });
    } finally {
      setSyncing(false);
    }
  };

  const handleUploadSubmit = async (e) => {
    e.preventDefault();
    if (!githubPat) return;
    
    setShowPasswordModal(false);
    setUploading(true);
    showToast("アップロードを開始しました。お待ちください...", "info", { clear: true });
    
    try {
      const response = await fetch("/api/system/upload-workspace", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${window.localStorage.getItem("anythingllm_authToken")}`
        },
        body: JSON.stringify({ slug: workspace.slug, githubPat })
      });
      
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to upload workspace");
      
      showToast("ナレッジのアップロードが完了しました。", "success", { clear: true });
    } catch (e) {
      console.error(e);
      showToast(`アップロードエラー: ${e.message}`, "error", { clear: true });
    } finally {
      setUploading(false);
      setGithubPat("");
    }
  };

  const handleWipeVectors = async () => {
    setShowWipeModal(false);
    setWiping(true);
    showToast("初期化を実行しています。お待ちください...", "info", { clear: true });
    
    try {
      const response = await fetch(`/api/system/workspace-vectors/${workspace.slug}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${window.localStorage.getItem("anythingllm_authToken")}`
        }
      });
      
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to wipe vectors");
      
      showToast("ベクトルデータを初期化しました。", "success", { clear: true });
      setTimeout(() => window.location.reload(), 2000);
    } catch (e) {
      console.error(e);
      showToast(`初期化エラー: ${e.message}`, "error", { clear: true });
    } finally {
      setWiping(false);
    }
  };

  return (
    <div className="mt-8">
      <div className="flex flex-col gap-y-2">
        <h2 className="text-xl font-semibold text-white">エンタープライズ・ナレッジ同期</h2>
        <p className="text-sm text-theme-text-secondary">
          全社共通のガイドラインやマニュアルを最新バージョンに同期します。管理者のみアップロードが可能です。
        </p>
      </div>

      <div className="flex flex-row items-center gap-x-4 mt-4">
        <button
          type="button"
          disabled={syncing || uploading || wiping}
          onClick={handleSync}
          className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-all text-sm font-medium disabled:opacity-50"
        >
          {syncing ? "同期を実行しています..." : "最新ナレッジを同期"}
        </button>

        <button
          type="button"
          disabled={syncing || uploading || wiping}
          onClick={() => setShowWipeModal(true)}
          className="px-4 py-2 rounded-lg bg-yellow-600 text-white hover:bg-yellow-700 transition-all text-sm font-medium disabled:opacity-50"
        >
          {wiping ? "初期化を実行しています..." : "ベクトルデータを初期化"}
        </button>

        <button
          type="button"
          disabled={syncing || uploading || wiping}
          onClick={() => setShowPasswordModal(true)}
          className="px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-all text-sm font-medium disabled:opacity-50"
        >
          {uploading ? "アップロードを実行しています..." : "ナレッジをアップロード"}
        </button>
      </div>

      {showWipeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-theme-bg-secondary p-6 rounded-lg shadow-xl w-full max-w-md border border-theme-border">
            <h3 className="text-lg font-semibold text-white mb-2">ベクトルデータの初期化</h3>
            <p className="text-sm text-theme-text-secondary mb-4">
              このワークスペースのベクトルデータを完全に削除します。この操作は取り消せません。<br/><br/>
              次回「最新ナレッジを同期」を実行するまで、このワークスペースのチャット機能は利用できなくなります。続行してもよろしいですか？
            </p>
            <div className="flex justify-end gap-x-3">
              <button
                type="button"
                onClick={() => setShowWipeModal(false)}
                className="px-4 py-2 text-sm text-theme-text-secondary hover:text-white transition-all"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleWipeVectors}
                className="px-4 py-2 text-sm bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-all"
              >
                実行する
              </button>
            </div>
          </div>
        </div>
      )}

      {showPasswordModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-theme-bg-secondary p-6 rounded-lg shadow-xl w-full max-w-md border border-theme-border">
            <h3 className="text-lg font-semibold text-white mb-2">GitHub 認証が必要です</h3>
            <p className="text-sm text-theme-text-secondary mb-4">
              ナレッジベースのアップロードにはGitHub Write PATが必要です。
            </p>
            <form onSubmit={handleUploadSubmit}>
              <input
                type="password"
                value={githubPat}
                onChange={(e) => setGithubPat(e.target.value)}
                placeholder="GitHub Write PATを入力 (github_pat_...)"
                className="w-full bg-theme-bg-primary text-white border border-theme-border rounded-lg px-4 py-2 mb-4 outline-none focus:border-blue-500"
                autoFocus
              />
              <div className="flex justify-end gap-x-3">
                <button
                  type="button"
                  onClick={() => setShowPasswordModal(false)}
                  className="px-4 py-2 text-sm text-theme-text-secondary hover:text-white transition-all"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-all"
                >
                  実行する
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
