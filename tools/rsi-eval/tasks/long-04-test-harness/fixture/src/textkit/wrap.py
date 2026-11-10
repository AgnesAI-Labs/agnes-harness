WIDTH = 10


def run(text):
    lines, line = [], ""
    for word in text.split(" "):
        if len(line) + 1 + len(word) > WIDTH:
            lines.append(line)
            line = word
        else:
            line = word if not line else line + " " + word
    lines.append(line)
    return "|".join(lines)
