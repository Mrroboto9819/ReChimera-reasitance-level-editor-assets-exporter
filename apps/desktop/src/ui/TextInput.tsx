import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  value: string;
  onValueChange: (next: string) => void;
  
  leading?: ReactNode;
  
  trailing?: ReactNode;
  

  type?: "text" | "search" | "url" | "email";
}






export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput(
    {
      value,
      onValueChange,
      leading,
      trailing,
      type = "text",
      className,
      placeholder,
      ...rest
    },
    ref,
  ) {
    const cls = ["text-input", className].filter(Boolean).join(" ");
    return (
      <div className={cls}>
        {leading}
        <input
          ref={ref}
          type={type}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          {...rest}
        />
        {trailing}
      </div>
    );
  },
);
