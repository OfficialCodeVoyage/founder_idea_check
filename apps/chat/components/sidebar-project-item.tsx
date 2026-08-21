"use client";

import {
  FlaskConical,
  ListChecks,
  MoreHorizontal,
  Network,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { DeleteProjectDialog } from "@/components/delete-project-dialog";
import { InternalLink } from "@/components/internal-link";
import {
  type ProjectDetailsData,
  ProjectDetailsDialog,
} from "@/components/project-details-dialog";
import { ProjectIcon } from "@/components/project-icon";
import { ProjectMenuItems } from "@/components/project-menu-items";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { useRenameProject } from "@/hooks/chat-sync-hooks";
import type { Project } from "@/lib/db/schema";
import type { ProjectColorName, ProjectIconName } from "@/lib/project-icons";

export function SidebarProjectItem({
  project,
  isActive,
  setOpenMobile,
}: {
  project: Project;
  isActive: boolean;
  setOpenMobile: (open: boolean) => void;
}) {
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const { mutateAsync: renameProject, isPending } = useRenameProject();

  const projectHref = `/project/${project.id}` as const;

  /**
   * `isActive` comes from `parseChatIdFromPathname`, which only recognises
   * `/project/:id` and `/project/:id/chat/:id`. The canvas and simulation paths
   * are deliberately NOT matched — that is what makes them `passthrough` and
   * therefore visible at all — so relying on `isActive` here would collapse the
   * sub-menu the moment you clicked into one of its own entries.
   */
  const pathname = usePathname();
  const isWithinProject =
    pathname === projectHref || pathname.startsWith(`${projectHref}/`);

  const handleRename = async (data: ProjectDetailsData) => {
    await renameProject({
      id: project.id,
      updates: {
        name: data.name,
        icon: data.icon,
        iconColor: data.color,
      },
    });
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        className="cursor-pointer"
        isActive={isActive || isWithinProject}
      >
        <InternalLink
          href={projectHref}
          onNavigate={() => {
            setOpenMobile(false);
          }}
          prefetch={false}
        >
          <ProjectIcon
            color={project.iconColor as ProjectColorName}
            icon={project.icon as ProjectIconName}
            size={16}
          />
          <span>{project.name}</span>
        </InternalLink>
      </SidebarMenuButton>

      <DropdownMenu modal={true}>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            className="mr-0.5 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            showOnHover={!isActive}
          >
            <MoreHorizontal size={16} />
            <span className="sr-only">More</span>
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="bottom">
          <ProjectMenuItems
            onDelete={() => setShowDeleteDialog(true)}
            onRename={() => setShowEditDialog(true)}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {isWithinProject ? (
        <SidebarMenuSub>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              asChild
              isActive={pathname === `${projectHref}/phases`}
            >
              <InternalLink
                href={`${projectHref}/phases`}
                onNavigate={() => setOpenMobile(false)}
                prefetch={false}
              >
                <ListChecks size={14} />
                <span>Phases</span>
              </InternalLink>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              asChild
              isActive={pathname === `${projectHref}/canvas`}
            >
              <InternalLink
                href={`${projectHref}/canvas`}
                onNavigate={() => setOpenMobile(false)}
                prefetch={false}
              >
                <Network size={14} />
                <span>Canvas</span>
              </InternalLink>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              asChild
              isActive={pathname === `${projectHref}/simulation`}
            >
              <InternalLink
                href={`${projectHref}/simulation`}
                onNavigate={() => setOpenMobile(false)}
                prefetch={false}
              >
                <FlaskConical size={14} />
                <span>Simulation</span>
              </InternalLink>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        </SidebarMenuSub>
      ) : null}

      <ProjectDetailsDialog
        initialColor={project.iconColor as ProjectColorName}
        initialIcon={project.icon as ProjectIconName}
        initialName={project.name}
        isLoading={isPending}
        mode="edit"
        onOpenChange={setShowEditDialog}
        onSubmit={handleRename}
        open={showEditDialog}
      />

      <DeleteProjectDialog
        deleteId={project.id}
        setShowDeleteDialog={setShowDeleteDialog}
        showDeleteDialog={showDeleteDialog}
      />
    </SidebarMenuItem>
  );
}
