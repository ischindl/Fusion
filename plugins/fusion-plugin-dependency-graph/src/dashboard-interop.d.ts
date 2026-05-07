declare module "@fusion/dashboard/app/components/TaskCard" {
  import type { Task } from "@fusion/core";
  import type { ReactElement } from "react";

  interface TaskCardProps {
    task: Task;
    projectId?: string;
    onOpenDetail: (task: Task) => void;
    addToast: (message: string, type?: "success" | "error" | "info") => void;
    disableDrag?: boolean;
  }

  export function TaskCard(props: TaskCardProps): ReactElement;
}
