import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
// Default height follows the page density: 44px for applicants and phones, 36px on staff screens from 640px.
const buttonVariants = cva("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm border border-transparent font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0", {
  variants: {
    variant: {
      default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover",
      secondary: "bg-secondary text-secondary-foreground hover:bg-secondary-hover",
      destructive: "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive-hover",
      outline: "border-input bg-card shadow-xs hover:bg-accent",
      ghost: "hover:bg-accent",
      link: "h-auto min-h-0 border-0 p-0 text-primary underline decoration-transparent underline-offset-4 hover:text-primary-hover hover:decoration-current",
    },
    size: {
      default: "min-h-(--control) px-3.5 text-sm",
      sm: "min-h-8 gap-1.5 px-2.5 text-[13px]",
      lg: "min-h-11 px-4.5 text-[15px]",
      icon: "size-(--control)",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});
function Button({ className, variant, size, asChild = false, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
export { Button, buttonVariants };
