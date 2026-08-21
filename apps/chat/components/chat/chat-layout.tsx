"use client";

import type { ComponentProps } from "react";
import { createContext, useContext } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

interface ChatLayoutContextValue {
  isSecondaryPanelVisible: boolean;
}

const ChatLayoutContext = createContext<ChatLayoutContextValue | null>(null);

function useChatLayoutContext() {
  const context = useContext(ChatLayoutContext);
  if (!context) {
    throw new Error("ChatLayout components must be used within <ChatLayout />");
  }
  return context;
}

type ChatLayoutProps = Omit<
  ComponentProps<typeof ResizablePanelGroup>,
  "direction"
> & {
  isSecondaryPanelVisible?: boolean;
};

export const ChatLayout = ({
  className,
  children,
  isSecondaryPanelVisible = false,
  ...props
}: ChatLayoutProps) => {
  const { state: sidebarState } = useSidebar();

  return (
    <ChatLayoutContext.Provider value={{ isSecondaryPanelVisible }}>
      <ResizablePanelGroup
        className={cn(
          "@container flex h-dvh max-h-dvh w-full min-w-0 max-w-screen flex-col bg-background md:max-w-[calc(100vw-var(--sidebar-width))]",
          sidebarState === "collapsed" && "md:max-w-screen",
          className
        )}
        direction="horizontal"
        {...props}
      >
        {children}
      </ResizablePanelGroup>
    </ChatLayoutContext.Provider>
  );
};

type ChatLayoutMainProps = ComponentProps<typeof ResizablePanel>;

export const ChatLayoutMain = ({
  className,
  defaultSize = 65,
  minSize = 40,
  ...props
}: ChatLayoutMainProps) => {
  const { isSecondaryPanelVisible } = useChatLayoutContext();

  return (
    <ResizablePanel
      className={cn(isSecondaryPanelVisible && "hidden md:block", className)}
      /**
       * 65 ONLY WHEN THERE IS SOMETHING TO SHARE THE ROW WITH.
       *
       * `ChatLayoutSecondary` and `ChatLayoutHandle` both return null while the
       * artifact panel is closed, which leaves this group with ONE panel
       * declaring `defaultSize={65}`. react-resizable-panels sums the declared
       * defaults in `calculateUnsafeDefaultLayout`, so `validatePanelGroupLayout`
       * logged "Invalid layout total size: 65%. Layout normalization will be
       * applied." on every clean load and then rescaled to 100 anyway. Declaring
       * the truth removes the warning without changing a single rendered pixel.
       *
       * Safe to change while mounted: Panel's constraint-sync effect deliberately
       * excludes `defaultSize`, and the group only recomputes a layout from
       * defaults when panels register or unregister — which is exactly when the
       * artifact panel opens, and child effects commit before the parent group's,
       * so the 65/35 split still applies the moment there are two panels.
       */
      defaultSize={isSecondaryPanelVisible ? defaultSize : 100}
      id="chat-main"
      minSize={minSize}
      order={1}
      {...props}
    />
  );
};

/**
 * `id` and `order` on both panels are what the library's second warning asks
 * for — "Panel id and order props recommended when panels are dynamically
 * rendered" — and this group renders its second panel conditionally. No
 * `autoSaveId` is set, so these ids are not yet part of a storage key; if one is
 * ever added, they become one.
 */
type ChatLayoutSecondaryProps = ComponentProps<typeof ResizablePanel>;

export const ChatLayoutSecondary = ({
  defaultSize = 35,
  minSize = 25,
  ...props
}: ChatLayoutSecondaryProps) => {
  const { isSecondaryPanelVisible } = useChatLayoutContext();

  if (!isSecondaryPanelVisible) {
    return null;
  }

  return (
    <ResizablePanel
      defaultSize={defaultSize}
      id="chat-secondary"
      minSize={minSize}
      order={2}
      {...props}
    />
  );
};

type ChatLayoutHandleProps = ComponentProps<typeof ResizableHandle>;

export const ChatLayoutHandle = ({
  className,
  withHandle = true,
  ...props
}: ChatLayoutHandleProps) => {
  const { isSecondaryPanelVisible } = useChatLayoutContext();

  if (!isSecondaryPanelVisible) {
    return null;
  }

  return (
    <ResizableHandle
      className={cn("hidden md:flex", className)}
      id="chat-main-secondary"
      withHandle={withHandle}
      {...props}
    />
  );
};
