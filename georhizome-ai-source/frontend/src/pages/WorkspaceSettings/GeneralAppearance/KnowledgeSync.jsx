import React, { useState } from "react";
import showToast from "@/utils/toast";

export default function KnowledgeSync({ workspace }) {
  const [syncing, setSyncing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [password, setPassword] = useState("");

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
    if (!password) return;
    
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
        body: JSON.stringify({ slug: workspace.slug, password })
      });
      
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to upload workspace");
      
      showToast("ナレッジのアップロードが完了しました。", "success", { clear: true });
    } catch (e) {
      console.error(e);
      showToast(`アップロードエラー: ${e.message}`, "error", { clear: true });
    } finally {
      setUploading(false);
      setPassword("");
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
          disabled={syncing || uploading}
          onClick={handleSync}
          className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-all text-sm font-medium disabled:opacity-50"
        >
          {syncing ? "同期を実行しています..." : "最新ナレッジを同期"}
        </button>

        <button
          type="button"
          disabled={syncing || uploading}
          onClick={() => setShowPasswordModal(true)}
          className="px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-all text-sm font-medium disabled:opacity-50"
        >
          {uploading ? "アップロードを実行しています..." : "ナレッジをアップロード"}
        </button>
      </div>

      {showPasswordModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-theme-bg-secondary p-6 rounded-lg shadow-xl w-full max-w-md border border-theme-border">
            <h3 className="text-lg font-semibold text-white mb-2">管理者権限が必要です</h3>
            <p className="text-sm text-theme-text-secondary mb-4">
              ナレッジベースのアップロードにはマスターパスワードが必要です。
            </p>
            <form onSubmit={handleUploadSubmit}>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="マスターパスワードを入力"
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
