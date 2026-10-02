import useScrollActiveItemIntoView from "@/hooks/useScrollActiveItemIntoView";
import Workspace from "@/models/workspace";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";
import {
  ArrowCounterClockwise,
  DotsThree,
  PencilSimple,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import ModalWrapper from "@/components/ModalWrapper";

const THREAD_CALLOUT_DETAIL_WIDTH = 26;
export default function ThreadItem({
  idx,
  activeIdx,
  isActive,
  workspace,
  thread,
  onRemove,
  toggleMarkForDeletion,
  hasNext,
  ctrlPressed = false,
}) {
  const { slug: urlSlug, threadSlug = null } = useParams();
  const workspaceSlug = workspace?.slug ?? urlSlug;
  const optionsContainer = useRef(null);

  const [showOptions, setShowOptions] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [renameValue, setRenameValue] = useState(thread.name);

  const confirmRename = async () => {
    const name = renameValue?.trim();
    if (!name || name.length === 0) {
      setShowRenameModal(false);
      return;
    }

    const { message } = await Workspace.threads.update(
      workspace.slug,
      thread.slug,
      { name }
    );
    if (!!message) {
      showToast(`スレッドを更新できませんでした！ ${message}`, "error", {
        clear: true,
      });
      setShowRenameModal(false);
      return;
    }

    thread.name = name;
    window.dispatchEvent(
      new CustomEvent("renameThread", {
        detail: { threadSlug: thread.slug, newName: name },
      })
    );
    setShowRenameModal(false);
  };

  const confirmDelete = async () => {
    const success = await Workspace.threads.delete(workspace.slug, thread.slug);
    if (!success) {
      showToast("スレッドを削除できませんでした！", "error", { clear: true });
      setShowDeleteModal(false);
      return;
    }
    if (success) {
      showToast("スレッドが正常に削除されました！", "success", { clear: true });
      onRemove(thread.id);
      // Redirect if deleting the active thread
      if (threadSlug === thread.slug) {
        window.location.href = paths.workspace.chat(workspace.slug);
      }
      setShowDeleteModal(false);
    }
  };

  const linkTo = thread.virtual
    ? "/"
    : !thread.slug
      ? paths.workspace.chat(workspaceSlug)
      : paths.workspace.thread(workspaceSlug, thread.slug);

  const { ref } = useScrollActiveItemIntoView({
    isActive,
    behavior: "instant",
    block: "center",
  });
  return (
    <>
      <div
        className="w-full relative flex h-[38px] items-center border-none rounded-lg"
        role="listitem"
      >
        {/* Curved line Element and leader if required */}
        <div
          style={{ width: THREAD_CALLOUT_DETAIL_WIDTH / 2 }}
          className={`${
            isActive
              ? "border-l-2 border-b-2 border-white light:border-blue-800 z-[2]"
              : "border-l border-b border-zinc-500 light:border-slate-400 z-[1]"
          } h-[50%] absolute top-0 left-3 rounded-bl-lg`}
        ></div>
        {/* Downstroke border for next item */}
        {hasNext && (
          <div
            style={{ width: THREAD_CALLOUT_DETAIL_WIDTH / 2 }}
            className={`${
              idx <= activeIdx && !isActive
                ? "border-l-2 border-white light:border-blue-800 z-[2]"
                : "border-l border-zinc-500 light:border-slate-400 z-[1]"
            } h-[100%] absolute top-0 left-3`}
          ></div>
        )}

        {/* Curved line inline placeholder for spacing - not visible */}
        <div
          style={{ width: THREAD_CALLOUT_DETAIL_WIDTH + 8 }}
          className="h-full"
        />
        <div
          className={`flex w-full items-center justify-between pr-2 group relative ${isActive ? "bg-[var(--theme-sidebar-thread-selected)] light:bg-blue-200" : "hover:bg-theme-sidebar-subitem-hover light:hover:bg-slate-300"} rounded-[4px]`}
        >
          {thread.deleted ? (
            <div className="w-full flex justify-between">
              <div className="w-full pl-2 py-1">
                <p
                  className={`text-left text-sm text-slate-400/50 light:text-slate-500 italic`}
                >
                  deleted thread
                </p>
              </div>
              {ctrlPressed && (
                <button
                  type="button"
                  className="border-none"
                  onClick={() => toggleMarkForDeletion(thread.id)}
                >
                  <ArrowCounterClockwise
                    className="text-zinc-300 hover:text-white light:text-theme-text-secondary hover:light:text-theme-text-primary"
                    size={18}
                  />
                </button>
              )}
            </div>
          ) : (
            <Link
              ref={ref}
              to={linkTo}
              data-tooltip-id="workspace-thread-name"
              data-tooltip-content={thread.name}
              className="w-full pl-2 py-1 overflow-hidden"
              aria-current={isActive ? "page" : ""}
            >
              <p
                className={`text-left text-sm truncate max-w-[150px] ${
                  isActive
                    ? "font-semibold text-theme-text-primary light:text-blue-900"
                    : "text-theme-text-primary font-medium light:text-slate-800"
                }`}
              >
                {thread.name}
              </p>
            </Link>
          )}
          {!!thread.slug && !thread.deleted && !thread.virtual && (
            <div ref={optionsContainer} className="flex items-center">
              {" "}
              {/* Added flex and items-center */}
              {ctrlPressed ? (
                <button
                  type="button"
                  className="border-none"
                  onClick={() => toggleMarkForDeletion(thread.id)}
                >
                  <X
                    className="text-zinc-300 light:text-theme-text-secondary hover:text-white hover:light:text-theme-text-primary"
                    weight="bold"
                    size={18}
                  />
                </button>
              ) : (
                <div className="flex items-center w-fit gap-x-1">
                  <button
                    type="button"
                    className="border-none thread-options-trigger"
                    onClick={() => setShowOptions(!showOptions)}
                    aria-label="Thread options"
                  >
                    <DotsThree
                      className="text-slate-300 light:text-theme-text-secondary hover:text-white hover:light:text-theme-text-primary"
                      size={25}
                    />
                  </button>
                </div>
              )}
              {showOptions && (
                <OptionsMenu
                  containerRef={optionsContainer}
                  onRename={() => {
                    setRenameValue(thread.name);
                    setShowRenameModal(true);
                  }}
                  onDelete={() => setShowDeleteModal(true)}
                  close={() => setShowOptions(false)}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {showRenameModal && (
        <ModalWrapper isOpen={showRenameModal}>
          <div className="relative w-[400px] max-w-full bg-theme-bg-secondary rounded-xl shadow-2xl border border-white/10 overflow-hidden glass backdrop-blur-xl">
            <div className="relative p-6 border-b border-white/10">
              <h3 className="text-lg font-semibold text-white tracking-tight">
                スレッド名を変更
              </h3>
            </div>
            <div className="p-6">
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                className="w-full bg-theme-bg-primary text-white border border-white/20 rounded-lg p-3 mb-6 focus:outline-none focus:ring-2 focus:ring-theme-green transition-all"
                autoFocus
              />
              <div className="flex justify-end gap-x-3">
                <button
                  onClick={() => setShowRenameModal(false)}
                  className="px-4 py-2 rounded-lg bg-transparent border border-white/20 hover:bg-white/5 text-white transition-all font-medium"
                >
                  キャンセル
                </button>
                <button
                  onClick={confirmRename}
                  className="px-4 py-2 rounded-lg bg-theme-green hover:opacity-80 text-white transition-all font-medium"
                >
                  変更を保存
                </button>
              </div>
            </div>
          </div>
        </ModalWrapper>
      )}

      {showDeleteModal && (
        <ModalWrapper isOpen={showDeleteModal}>
          <div className="relative w-[400px] max-w-full bg-theme-bg-secondary rounded-xl shadow-2xl border border-white/10 overflow-hidden glass backdrop-blur-xl">
            <div className="relative p-6 border-b border-white/10">
              <h3 className="text-lg font-semibold text-white tracking-tight">
                スレッドを削除
              </h3>
            </div>
            <div className="p-6">
              <p className="text-white/80 mb-6 leading-relaxed">
                このスレッドを削除してもよろしいですか？すべてのチャットが完全に削除されます。この操作は元に戻せません。
              </p>
              <div className="flex justify-end gap-x-3">
                <button
                  onClick={() => setShowDeleteModal(false)}
                  className="px-4 py-2 rounded-lg bg-transparent border border-white/20 hover:bg-white/5 text-white transition-all font-medium"
                >
                  キャンセル
                </button>
                <button
                  onClick={confirmDelete}
                  className="px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 shadow-[0_0_15px_rgba(239,68,68,0.3)] text-white transition-all font-medium"
                >
                  スレッドを削除
                </button>
              </div>
            </div>
          </div>
        </ModalWrapper>
      )}
    </>
  );
}

function OptionsMenu({ containerRef, onRename, onDelete, close }) {
  const menuRef = useRef(null);

  const outsideClick = (e) => {
    if (!menuRef.current) return false;
    if (
      !menuRef.current?.contains(e.target) &&
      !containerRef.current?.contains(e.target)
    )
      close();
    return false;
  };

  const isEsc = (e) => {
    if (e.key === "Escape" || e.key === "Esc") close();
  };

  function cleanupListeners() {
    window.removeEventListener("click", outsideClick);
    window.removeEventListener("keyup", isEsc);
  }

  useEffect(() => {
    function setListeners() {
      if (!menuRef?.current || !containerRef.current) return false;
      window.document.addEventListener("click", outsideClick);
      window.document.addEventListener("keyup", isEsc);
    }

    setListeners();
    return cleanupListeners;
  }, [menuRef, containerRef]);

  return (
    <div
      ref={menuRef}
      className="absolute w-fit z-[99] top-[25px] right-[10px] bg-theme-bg-secondary glass backdrop-blur-xl border border-white/10 rounded-lg p-1 shadow-2xl"
    >
      <button
        onClick={() => {
          onRename();
          close();
        }}
        type="button"
        className="w-full rounded-md flex items-center p-2 gap-x-2 hover:bg-white/10 text-white transition-all"
      >
        <PencilSimple size={18} />
        <p className="text-sm font-medium">名前を変更</p>
      </button>
      <button
        onClick={() => {
          onDelete();
          close();
        }}
        type="button"
        className="w-full rounded-md flex items-center p-2 gap-x-2 hover:bg-red-500/20 text-white hover:text-red-400 transition-all"
      >
        <Trash size={18} />
        <p className="text-sm font-medium">削除</p>
      </button>
    </div>
  );
}
