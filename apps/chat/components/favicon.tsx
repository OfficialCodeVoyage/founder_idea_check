import { Globe } from "lucide-react";
import type React from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { getSiteInitial } from "@/lib/url-utils";
import { cn } from "@/lib/utils";

/**
 * A SITE'S MARK, DRAWN LOCALLY: THE FIRST LETTER OF ITS DOMAIN, OR A GLOBE.
 *
 * This used to be an `<img>` pointing at Google's favicon service, one request
 * per cited domain and per connector. Those requests told Google which sites a
 * founder's research cites, before the idea is built or anything is public, and
 * some of them 404ed into the console. Nothing here touches the network: the
 * mark is a pure function of the URL, so it is stable across renders and
 * identical for every reader.
 *
 * `url` is the SITE's address (or bare hostname), not an icon address. The
 * badge is decorative: the domain or the source's title is always printed next
 * to it, so it is hidden from assistive technology.
 *
 * The letter is sized in container-query units so one badge fits every caller,
 * from the 12px chip to the 20px overlapping stack.
 */
export function Favicon({
  url,
  className,
  ...props
}: {
  url: string;
  className?: string;
} & React.HTMLAttributes<HTMLSpanElement>) {
  const initial = getSiteInitial(url);
  return (
    <Avatar
      aria-hidden
      className={cn("h-4 w-4 rounded-sm [container-type:size]", className)}
      {...props}
    >
      <AvatarFallback className="rounded-none font-medium text-[62cqh] text-muted-foreground uppercase leading-none">
        {initial ?? <Globe className="size-[70%]" />}
      </AvatarFallback>
    </Avatar>
  );
}
