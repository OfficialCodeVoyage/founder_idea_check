import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createProject,
  deleteProject,
  getProjectById,
  getProjectsByUserId,
  updateProject,
} from "@/lib/db/queries";
import { PROJECT_COLOR_NAMES, PROJECT_ICONS } from "@/lib/project-icons";
import { generateUUID } from "@/lib/utils";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";

/**
 * The caller's project, or NOT_FOUND. "No such project" and "not yours" are
 * deliberately the same answer: a FORBIDDEN for the second told a caller that
 * the id they guessed exists and belongs to someone — the posture
 * `phase.router.ts` takes in `getState`, `attempts` and `currentLedger`.
 */
async function getOwnedProject({ id, userId }: { id: string; userId: string }) {
  const project = await getProjectById({ id });
  if (!project || project.userId !== userId) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Project not found",
    });
  }
  return project;
}

export const projectRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    const projects = await getProjectsByUserId({ userId: ctx.user.id });
    return projects;
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        instructions: z.string().default(""),
        icon: z.enum(PROJECT_ICONS).optional(),
        iconColor: z.enum(PROJECT_COLOR_NAMES).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = generateUUID();
      await createProject({
        id,
        userId: ctx.user.id,
        name: input.name,
        instructions: input.instructions,
        icon: input.icon,
        iconColor: input.iconColor,
      });
      return { id };
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return await getOwnedProject({ id: input.id, userId: ctx.user.id });
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        updates: z.object({
          name: z.string().min(1).optional(),
          instructions: z.string().optional(),
          icon: z.enum(PROJECT_ICONS).optional(),
          iconColor: z.enum(PROJECT_COLOR_NAMES).optional(),
        }),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await getOwnedProject({ id: input.id, userId: ctx.user.id });
      await updateProject({ id: input.id, updates: input.updates });
      return { success: true };
    }),

  setInstructions: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        instructions: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await getOwnedProject({ id: input.id, userId: ctx.user.id });
      await updateProject({
        id: input.id,
        updates: { instructions: input.instructions },
      });
      return { success: true };
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await getOwnedProject({ id: input.id, userId: ctx.user.id });
      await deleteProject({ id: input.id });
      return { success: true };
    }),
});
