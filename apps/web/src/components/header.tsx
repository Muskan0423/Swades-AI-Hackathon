"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ModeToggle } from "./mode-toggle";

export default function Header() {
  const pathname = usePathname();
  
  const links = [
    { to: "/", label: "Home" },
    { to: "/recorder", label: "Recorder" },
  ] as const;

  return (
    <div>
      <div className="flex flex-row items-center justify-between px-4 py-3">
        <nav className="flex gap-6">
          {links.map(({ to, label }) => {
            const isActive = pathname === to;
            return (
              <Link 
                key={to} 
                href={to}
                className={`text-sm font-medium transition-colors hover:text-foreground ${
                  isActive 
                    ? "text-foreground" 
                    : "text-muted-foreground"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-2">
          <ModeToggle />
        </div>
      </div>
      <hr className="border-border" />
    </div>
  );
}
