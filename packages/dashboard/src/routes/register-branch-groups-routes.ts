import { Router, type Request } from "express";
import type { BranchGroup, TaskStore } from "@fusion/core";
import { isBranchGroupComplete, isBranchGroupMemberLanded } from "@fusion/core";
import { badRequest, notFound } from "../api-error.js";

export interface BranchGroupsRouterOptions {
  promoteBranchGroup?: (input: { groupId: string; projectId?: string }) => Promise<Record<string, unknown>>;
}

function parseProjectId(req: Request): string | undefined {
  const value = req.query.projectId ?? req.body?.projectId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function serializeGroup(store: TaskStore, group: BranchGroup) {
  const members = await store.listTasksByBranchGroup(group.id);
  const memberRows = members.map((task) => ({
    taskId: task.id,
    title: task.title ?? task.description,
    column: task.column,
    landed: isBranchGroupMemberLanded(task, group),
  }));
  const landedCount = memberRows.filter((member) => member.landed).length;
  return {
    ...group,
    members: memberRows,
    completion: {
      landed: landedCount,
      total: memberRows.length,
      complete: isBranchGroupComplete(members, group),
    },
  };
}

export function createBranchGroupsRouter(store: TaskStore, options?: BranchGroupsRouterOptions): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const statusRaw = req.query.status;
    const status = typeof statusRaw === "string" && statusRaw.trim() ? statusRaw.trim() : undefined;
    if (status && status !== "open" && status !== "finalized" && status !== "abandoned") {
      throw badRequest("status must be one of: open, finalized, abandoned");
    }

    const groups = store.listBranchGroups(status ? { status: status as BranchGroup["status"] } : undefined);
    const data = await Promise.all(groups.map((group) => serializeGroup(store, group)));
    res.json({ groups: data });
  });

  router.get("/:id", async (req, res) => {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw badRequest("id is required");
    const group = store.getBranchGroup(id);
    if (!group) throw notFound("Branch group not found");
    res.json({ group: await serializeGroup(store, group) });
  });

  router.post("/assign", async (req, res) => {
    const taskId = typeof req.body?.taskId === "string" ? req.body.taskId.trim() : "";
    if (!taskId) throw badRequest("taskId is required");

    const task = await store.getTask(taskId);
    const groupIdBody = req.body?.groupId;
    const branchNameRaw = req.body?.branchName;
    const branchName = typeof branchNameRaw === "string" && branchNameRaw.trim() ? branchNameRaw.trim() : undefined;

    if (groupIdBody === null) {
      await store.setTaskBranchGroup(taskId, null);
      res.json({ taskId, groupId: null });
      return;
    }

    let groupId = typeof groupIdBody === "string" && groupIdBody.trim() ? groupIdBody.trim() : undefined;
    if (!groupId) {
      if (!branchName) throw badRequest("branchName is required when groupId is not provided");
      const sourceType = task.branchContext?.source ?? "planning";
      const sourceId = `task:${task.id}`;
      const created = store.ensureBranchGroupForSource(sourceType, sourceId, {
        branchName,
        autoMerge: task.autoMerge ?? false,
      });
      groupId = created.id;
    } else if (!store.getBranchGroup(groupId)) {
      throw notFound("Branch group not found");
    }

    await store.setTaskBranchGroup(taskId, groupId);
    res.json({ taskId, groupId });
  });

  router.post("/:id/promote", async (req, res) => {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw badRequest("id is required");
    const group = store.getBranchGroup(id);
    if (!group) throw notFound("Branch group not found");

    const members = await store.listTasksByBranchGroup(group.id);
    if (!isBranchGroupComplete(members, group)) {
      throw badRequest("Branch group completion gate not satisfied");
    }

    const promote = options?.promoteBranchGroup;
    if (!promote) {
      throw badRequest("Branch-group promotion is unavailable");
    }

    const result = await promote({ groupId: id, projectId: parseProjectId(req) });
    res.json({ groupId: id, ...result });
  });

  return router;
}
