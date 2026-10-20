import React, { useState } from "react";
import showToast from "@/utils/toast";
import { useTranslation } from "react-i18next";
import KnowledgeSyncModel from "@/models/knowledgeSync";
import PassphrasePromptModal from "@/components/KnowledgeSync/PassphrasePromptModal";
import useUser from "@/hooks/useUser";
import { formatKsError } from "@/utils/knowledgeSyncErrors";

export default function KnowledgeSync({ workspace }) {
  const { t } = useTranslation();
  const { user } = useUser();
  // Upload is admin-only server-side (KS_ADMIN_GATE); single-user has no user.
  const canUpload = !user || user.role === "admin";
  const [showPassphrasePrompt, setShowPassphrasePrompt] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [wiping, setWiping] = useState(false);

  // Knowledge Sync routes return { error: { code, message } }; legacy ones a string.
  const errorText = (data, status, fallback) =>
    data?.error?.code || status === 401 || status === 403
      ? formatKsError(t, { ...data?.error, status })
      : data?.error || fallback;

  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showWipeModal, setShowWipeModal] = useState(false);

  const handleSyncClick = async () => {
    const { ok, data } = await KnowledgeSyncModel.status();
    if (ok && data?.passphrase?.configured === false) {
      setShowPassphrasePrompt(true);
      return;
    }
    handleSync();
  };

  const handleSync = async () => {
    setSyncing(true);
    showToast(t("knowledgeSync.sync.started"), "info", { clear: true });
    try {
      const response = await fetch("/api/system/sync-workspace", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${window.localStorage.getItem("anythingllm_authToken")}`,
        },
        body: JSON.stringify({ slug: workspace.slug }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          errorText(data, response.status, "Failed to sync workspace")
        );

      showToast(t("knowledgeSync.sync.done"), "success", { clear: true });
      setTimeout(() => window.location.reload(), 2000);
    } catch (e) {
      console.error(e);
      showToast(
        t("knowledgeSync.sync.failed", { message: e.message }),
        "error",
        {
          clear: true,
        }
      );
    } finally {
      setSyncing(false);
    }
  };

  // The GitHub token comes from Settings -> Knowledge Sync (server-side store).
  const handleUpload = async () => {
    setShowUploadModal(false);
    setUploading(true);
    showToast("アップロードを開始しました。お待ちください...", "info", {
      clear: true,
    });

    try {
      const response = await fetch("/api/system/upload-workspace", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${window.localStorage.getItem("anythingllm_authToken")}`,
        },
        body: JSON.stringify({ slug: workspace.slug }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          errorText(data, response.status, "Failed to upload workspace")
        );

      showToast("ナレッジのアップロードが完了しました。", "success", {
        clear: true,
      });
    } catch (e) {
      console.error(e);
      showToast(`アップロードエラー: ${e.message}`, "error", { clear: true });
    } finally {
      setUploading(false);
    }
  };

  const handleWipeVectors = async () => {
    setShowWipeModal(false);
    setWiping(true);
    showToast("初期化を実行しています。お待ちください...", "info", {
      clear: true,
    });

    try {
      const response = await fetch(
        `/api/system/workspace-vectors/${workspace.slug}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${window.localStorage.getItem("anythingllm_authToken")}`,
          },
        }
      );

      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          errorText(data, response.status, "Failed to wipe vectors")
        );

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
        <h2 className="text-xl font-semibold text-white">
          エンタープライズ・ナレッジ同期
        </h2>
        <p className="text-sm text-theme-text-secondary">
          全社共通のガイドラインやマニュアルを最新バージョンに同期します。管理者のみアップロードが可能です。
        </p>
      </div>

      <div className="flex flex-row items-center gap-x-4 mt-4">
        <button
          type="button"
          disabled={syncing || uploading || wiping}
          onClick={handleSyncClick}
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

        {canUpload && (
          <button
            type="button"
            disabled={syncing || uploading || wiping}
            onClick={() => setShowUploadModal(true)}
            className="px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-all text-sm font-medium disabled:opacity-50"
          >
            {uploading
              ? "アップロードを実行しています..."
              : "ナレッジをアップロード"}
          </button>
        )}
      </div>

      {showPassphrasePrompt && (
        <PassphrasePromptModal
          onCancel={() => setShowPassphrasePrompt(false)}
          onSaved={() => {
            setShowPassphrasePrompt(false);
            handleSync();
          }}
        />
      )}

      {showWipeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-theme-bg-secondary p-6 rounded-lg shadow-xl w-full max-w-md border border-theme-border">
            <h3 className="text-lg font-semibold text-white mb-2">
              ベクトルデータの初期化
            </h3>
            <p className="text-sm text-theme-text-secondary mb-4">
              このワークスペースのベクトルデータを完全に削除します。この操作は取り消せません。
              <br />
              <br />
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

      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-theme-bg-secondary p-6 rounded-lg shadow-xl w-full max-w-md border border-theme-border">
            <h3 className="text-lg font-semibold text-white mb-2">
              ナレッジのアップロード
            </h3>
            <p className="text-sm text-theme-text-secondary mb-4">
              このワークスペースのナレッジをGitHubにアップロードします。設定の「ナレッジ同期」で保存したGitHubアクセストークンを使用します。続行してもよろしいですか？
            </p>
            <div className="flex justify-end gap-x-3">
              <button
                type="button"
                onClick={() => setShowUploadModal(false)}
                className="px-4 py-2 text-sm text-theme-text-secondary hover:text-white transition-all"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleUpload}
                className="px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-all"
              >
                実行する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
