import type { ReactNode } from "react";
import type { User } from "@plakk/shared";
import { SettingsIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "./primitives/avatar.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./primitives/dropdown-menu.js";
import { getInitials } from "../lib/getInitials.js";
import { cn } from "../lib/utils.js";

export function AppHeader(props: {
  user: User;
  storageAction: ReactNode;
  className?: string;
  onSettingsClick?: () => void;
  onSignOutClick?: () => void;
}) {
  const { user, storageAction, className, onSettingsClick, onSignOutClick } = props;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  const displayName = name || user.email;

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
              <AvatarFallback className="text-xs">{getInitials(name, user.email)}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <div className="flex items-center gap-3 px-2 py-1.5">
              <Avatar className="size-9">
                <AvatarFallback className="text-xs">{getInitials(name, user.email)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{displayName}</p>
                <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              </div>
            </div>
            <DropdownMenuSeparator />
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
