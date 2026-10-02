import { v4 } from "uuid";
import { safeJsonParse } from "../request";
import { API_BASE } from "../constants";
import { useEffect, useState } from "react";
import { THREAD_RENAME_EVENT } from "@/components/Sidebar/ActiveWorkspaces/ThreadContainer";

export const AGENT_SESSION_START = "agentSessionStart";
export const AGENT_SESSION_END = "agentSessionEnd";
const handledEvents = [
  "statusResponse",
  "fileDownloadCard",
  "awaitingFeedback",
  "wssFailure",
  "rechartVisualize",
  "toolApprovalRequest",
  // Streaming events
  "reportStreamEvent",
];

export function websocketURI() {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (API_BASE === "/api") return `${wsProtocol}//${window.location.host}`;
  return `${wsProtocol}//${new URL(import.meta.env.VITE_API_BASE).host}`;
}

export default function handleSocketResponse(socket, event, setChatHistory) {
  const data = safeJsonParse(event.data, null);
  if (data === null) return;

  // Handle thread rename
  if (data.type === "rename_thread") {
    const { slug, name } = data.content || {};
    if (slug && name) {
      window.dispatchEvent(
        new CustomEvent(THREAD_RENAME_EVENT, {
          detail: { threadSlug: slug, newName: name },
        })
      );
    }
    return;
  }

  // No message type is defined then this is a generic message
  // that we need to print to the user as a system response (or agent direct message)
  if (!data.hasOwnProperty("type")) {
    if (!data.content) return;
    return setChatHistory((prev) => {
      // If there's an active streaming textResponse with this content or uuid, avoid duplication
      const existingMsg = prev.find((m) => m.content === data.content);
      if (existingMsg) return prev;

      return [
        ...prev.filter((msg) => !!msg.content),
        {
          uuid: v4(),
          content: data.content,
          role: "assistant",
          sources: [],
          closed: true,
          error: null,
          animate: false,
          pending: false,
          metrics: {},
        },
      ];
    });
  }

  // toolApprovalRequest doesn't have content field, so check separately
  if (data.type === "toolApprovalRequest") {
    if (!data.requestId || !data.skillName) return;
  } else if (data.type === "WAITING_ON_INPUT") {
    // Silently auto-exit the agent session when it is waiting for input
    // so the user does not have to manually type /exit.
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "awaitingFeedback",
          feedback: "/exit",
          attachments: [],
        })
      );
    }
    return;
  } else if (!handledEvents.includes(data.type) || !data.content) {
    return;
  }

  if (data.type === "reportStreamEvent") {
    // Enable agent streaming for the next message so we can handle streaming or non-streaming responses
    // If we get this message we know the provider supports agentic streaming
    socket.supportsAgentStreaming = true;

    return setChatHistory((prev) => {
      if (data.content.type === "removeStatusResponse")
        return [...prev.filter((msg) => msg.uuid !== data.content.uuid)];

      const knownMessage = data.content.uuid
        ? prev.find((msg) => msg.uuid === data.content.uuid)
        : null;
      if (!knownMessage) {
        if (data.content.type === "fullTextResponse") {
          const pendingIdx = prev.findIndex(
            (msg) => msg.role === "assistant" && msg.pending && !msg.content
          );
          if (pendingIdx !== -1) {
            const newMsg = {
              uuid: data.content.uuid,
              type: "textResponse",
              content: data.content.content,
              role: "assistant",
              sources: prev[pendingIdx].sources || [],
              closed: true,
              error: null,
              animate: false,
              pending: false,
              metrics: {},
            };
            return [
              ...prev.slice(0, pendingIdx),
              newMsg,
              ...prev.slice(pendingIdx + 1),
            ];
          }

          const existingMsg = prev.find((msg) => msg.uuid === data.content.uuid);
          return [
            ...prev.filter(
              (msg) => (!!msg.content || !!msg.userMessage || msg.pending) && msg.uuid !== data.content.uuid
            ),
            {
              uuid: data.content.uuid,
              type: "textResponse",
              content: data.content.content,
              role: "assistant",
              sources: existingMsg?.sources || [],
              closed: true,
              error: null,
              animate: false,
              pending: false,
              metrics: existingMsg?.metrics || {},
              chatId: existingMsg?.chatId || null,
            },
          ];
        }

        // Handle textResponseChunk initialization as textResponse instead of statusResponse.
        // Without this the first chunk creates a statusResponse (thought bubble) by falling through to the default case.
        // Providers like Gemini send large chunks and can complete in a single chunk before the update logic can convert it.
        // Other providers send many small chunks so the second chunk triggers the update logic to fix the type.
        if (data.content.type === "textResponseChunk") {
          if (data.content.content.trim() === "") return prev;

          // Find if there's a pending empty assistant message to replace
          const pendingIdx = prev.findIndex(
            (msg) => msg.role === "assistant" && msg.pending && !msg.content
          );
          if (pendingIdx !== -1) {
            const newMsg = {
              uuid: data.content.uuid,
              type: "textResponse",
              content: data.content.content,
              role: "assistant",
              sources: prev[pendingIdx].sources || [],
              closed: true,
              error: null,
              animate: false,
              pending: false,
              metrics: {},
            };
            return [
              ...prev.slice(0, pendingIdx),
              newMsg,
              ...prev.slice(pendingIdx + 1),
            ];
          }

          const existingMsg = prev.find((msg) => msg.uuid === data.content.uuid);
          return [
            ...prev.filter(
              (msg) => (!!msg.content || !!msg.userMessage || msg.pending) && msg.uuid !== data.content.uuid
            ),
            {
              uuid: data.content.uuid,
              type: "textResponse",
              content: data.content.content,
              role: "assistant",
              sources: existingMsg?.sources || [],
              closed: true,
              error: null,
              animate: false,
              pending: false,
              metrics: existingMsg?.metrics || {},
              chatId: existingMsg?.chatId || null,
            },
          ];
        }

        // Find if there's a pending empty assistant message to replace
        const pendingIdx = prev.findIndex(
          (msg) => msg.role === "assistant" && msg.pending && !msg.content
        );
        if (pendingIdx !== -1) {
          const newMsg = {
            uuid: data.content.uuid,
            type: "statusResponse",
            content: data.content.content,
            role: "assistant",
            sources: prev[pendingIdx].sources || [],
            closed: true,
            error: null,
            animate: false,
            pending: false,
            metrics: {},
          };
          return [
            ...prev.slice(0, pendingIdx),
            newMsg,
            ...prev.slice(pendingIdx + 1),
          ];
        }

        return [
          ...prev.filter(
            (msg) => !!msg.content || !!msg.userMessage || msg.pending
          ),
          {
            uuid: data.content.uuid,
            type: "statusResponse",
            content: data.content.content,
            role: "assistant",
            sources: [],
            closed: true,
            error: null,
            animate: false,
            pending: false,
            metrics: {},
          },
        ];
      } else {
        const { type, content, uuid } = data.content;
        // For tool call invocations, we need to update the existing message entirely since it is accumulated
        // and we dont know if the function will have arguments or not while streaming - so replace the existing message entirely
        if (type === "toolCallInvocation") {
          const knownMessage = prev.find((msg) => msg.uuid === uuid);
          if (!knownMessage)
            return [...prev, { uuid, type: "toolCallInvocation", content }]; // If the message is not known, add it to the end of the list
          return [
            ...prev.filter((msg) => msg.uuid !== uuid),
            { ...knownMessage, content },
          ]; // If the message is known, replace it with the new content
        }

        if (type === "usageMetrics") {
          const msgExists = prev.some((msg) => msg.uuid === uuid);
          if (!msgExists) {
            return [
              ...prev.filter((msg) => !!msg.content || !!msg.userMessage || msg.pending),
              {
                uuid,
                type: "textResponse",
                content: "",
                role: "assistant",
                sources: [],
                closed: true,
                error: null,
                animate: false,
                pending: false,
                metrics: data.content.metrics,
              }
            ];
          }

          return prev.map((msg) =>
            msg.uuid === uuid
              ? { ...msg, metrics: data.content.metrics }
              : msg
          );
        }

        if (type === "citations") {
          if (!data.content.citations) return prev;
          const msgExists = prev.some((msg) => msg.uuid === uuid);
          
          if (!msgExists) {
            // The citations arrived before the textResponseChunk created the bubble!
            // Create a pending text bubble with the citations attached.
            return [
              ...prev.filter((msg) => !!msg.content || !!msg.userMessage || msg.pending),
              {
                uuid,
                type: "textResponse",
                content: "",
                role: "assistant",
                sources: data.content.citations,
                closed: true,
                error: null,
                animate: false,
                pending: false,
                metrics: {},
              }
            ];
          }

          return prev.map((msg) => {
            if (msg.uuid === uuid) {
              return {
                ...msg,
                sources: [...(msg.sources || []), ...data.content.citations],
              };
            }
            return msg;
          });
        }

        if (type === "chatId") {
          if (!data.content.chatId) return prev;
          const msgExists = prev.some((msg) => msg.uuid === uuid);

          if (!msgExists) {
            return [
              ...prev.filter((msg) => !!msg.content || !!msg.userMessage || msg.pending),
              {
                uuid,
                type: "textResponse",
                content: "",
                role: "assistant",
                sources: [],
                closed: true,
                error: null,
                animate: false,
                pending: false,
                metrics: {},
                chatId: data.content.chatId,
              }
            ];
          }

          return prev.map((msg) => {
            if (msg.uuid === uuid) {
              return { ...msg, chatId: data.content.chatId };
            }
            return msg;
          });
        }

        if (type === "textResponseChunk") {
          return prev
            .map((msg) =>
              msg.uuid === uuid
                ? {
                    ...msg,
                    type: "textResponse",
                    content: msg.content + content,
                  }
                : msg?.content
                  ? msg
                  : null
            )
            .filter((msg) => !!msg);
        }

        // Generic text response - will be put in the agent thought bubble
        return prev.map((msg) =>
          msg.uuid === data.content.uuid
            ? { ...msg, content: msg.content + data.content.content }
            : msg
        );
      }
    });
  }

  if (data.type === "fileDownloadCard") {
    return setChatHistory((prev) => {
      return [
        ...prev.filter((msg) => !!msg.content),
        {
          type: "fileDownloadCard",
          uuid: v4(),
          content: data.content,
          role: "assistant",
          sources: [],
          closed: true,
          error: null,
          animate: false,
          pending: false,
          metrics: data.metrics || {},
        },
      ];
    });
  }

  if (data.type === "rechartVisualize") {
    return setChatHistory((prev) => {
      return [
        ...prev.filter((msg) => !!msg.content),
        {
          type: "rechartVisualize",
          uuid: v4(),
          content: data.content,
          role: "assistant",
          sources: [],
          closed: true,
          error: null,
          animate: false,
          pending: false,
          metrics: data.metrics || {},
        },
      ];
    });
  }

  if (data.type === "wssFailure") {
    return setChatHistory((prev) => {
      return [
        ...prev.filter((msg) => !!msg.content),
        {
          uuid: v4(),
          content: data.content,
          role: "assistant",
          sources: [],
          closed: true,
          error: data.content,
          animate: false,
          pending: false,
          metrics: {},
        },
      ];
    });
  }

  if (data.type === "toolApprovalRequest") {
    return setChatHistory((prev) => {
      return [
        ...prev.filter((msg) => !!msg.content),
        {
          uuid: v4(),
          type: "toolApprovalRequest",
          requestId: data.requestId,
          skillName: data.skillName,
          payload: data.payload,
          description: data.description,
          timeoutMs: data.timeoutMs,
          content: `Approval requested for ${data.skillName}`,
          role: "assistant",
          sources: [],
          closed: false,
          error: null,
          animate: false,
          pending: true,
          metrics: {},
        },
      ];
    });
  }

  return setChatHistory((prev) => {
    return [
      ...prev.filter((msg) => !!msg.content),
      {
        uuid: v4(),
        type: data.type,
        content: data.content,
        role: "assistant",
        sources: [],
        closed: true,
        error: null,
        animate: data?.animate || false,
        pending: false,
        metrics: data.metrics || {},
      },
    ];
  });
}

let _agentSessionActive = false;
export function setAgentSessionActive(value) {
  _agentSessionActive = value;
}
export function getAgentSessionActive() {
  return _agentSessionActive;
}

export function useIsAgentSessionActive() {
  const [activeSession, setActiveSession] = useState(
    () => !!getAgentSessionActive()
  );
  useEffect(() => {
    function listenForAgentSession() {
      if (!window) return;
      window.addEventListener(AGENT_SESSION_START, () =>
        setActiveSession(true)
      );
      window.addEventListener(AGENT_SESSION_END, () => setActiveSession(false));
    }
    listenForAgentSession();
  }, []);

  return activeSession;
}
