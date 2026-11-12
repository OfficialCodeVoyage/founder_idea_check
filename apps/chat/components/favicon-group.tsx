import type React from "react";
import { cn } from "@/lib/utils";
import { Favicon } from "./favicon";

// Only the address is needed: the mark is drawn from the domain, locally.
interface FaviconSource {
  url: string;
}

interface FaviconGroupProps {
  className?: string;
  maxVisible?: number;
  sources: FaviconSource[]; // Use the simpler interface
}

export const FaviconGroup: React.FC<FaviconGroupProps> = ({
  sources,
  maxVisible = 4,
  className,
}) => {
  const visibleSources = sources.slice(0, maxVisible);

  return (
    <div className={cn("flex items-center", className)}>
      {visibleSources.map((source, index) => (
        <Favicon
          className={cn(
            "h-5 w-5 rounded-full border-2 border-background",
            index > 0 ? "-ml-2" : ""
          )}
          key={source.url || index}
          style={{ zIndex: maxVisible - index }}
          url={source.url}
        />
      ))}
    </div>
  );
};
