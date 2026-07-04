import type { User } from "@plakk/shared";
import type { ReactNode } from "react";
import { SettingsIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "./primitives/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./primitives/dropdown-menu";
import { getInitials } from "../lib/getInitials";
import { cn } from "../lib/utils";

export function AppHeader(props: {
  user: User;
  storageAction: ReactNode;
  className?: string;
  onSettingsClick?: () => void;
  onSignOutClick?: () => void;
}) {
  const { user, storageAction, className, onSettingsClick, onSignOutClick } = props;

  return (
    <header className={cn("drag-region flex h-9 items-center justify-between px-6", className)}>
      <div className="flex items-center gap-2">
        <span className="text-lg leading-none font-semibold tracking-tight">Plakk</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-wide text-muted-foreground">
          BETA
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        {storageAction}
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Account menu">
            <Avatar className="size-8">
              <AvatarFallback className="text-xs">{getInitials(user)}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onSettingsClick}>
              <SettingsIcon />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onSignOutClick}>
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
