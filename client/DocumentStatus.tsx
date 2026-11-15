import { Check } from "lucide-react";
import { statusText } from "./types";

export function DocumentStatus({
  status,
  doc,
}: {
  status: string;
  doc?: { categoryId?: string };
}) {
  return (
    <span className={"badge " + status.toLowerCase()}>
      {status === "READY" ? (
        <Check size={15} aria-hidden="true" />
      ) : (
        <span className="dot" />
      )}
      {statusText(status, doc)}
    </span>
  );
}
