def run(text):
    out = []
    for ch in text.lower():
        if ch == " ":
            out.append("-")
        elif ch.isascii() and (ch.isalnum() or ch == "-"):
            out.append(ch)
    return "".join(out)
