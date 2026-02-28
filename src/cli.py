"""Terminal interface for Anxious Intelligence."""

import asyncio
import sys
import uuid
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.text import Text
from rich.live import Live
from rich.progress import BarColumn, Progress

from src.db import get_pool, close_pool
from src.belief_graph import get_active_beliefs, seed_beliefs, get_contradictions, get_connected_beliefs
from src.dissatisfaction import compute_dissatisfaction, get_dissatisfaction_breakdown, describe_state
from src.revision_engine import get_recent_revisions
from src.orchestrator import process_interaction

console = Console()


def tension_bar(value: float, width: int = 20) -> str:
    filled = int(value * width)
    if value < 0.3:
        color = "green"
    elif value < 0.6:
        color = "yellow"
    else:
        color = "red"
    bar = "█" * filled + "░" * (width - filled)
    return f"[{color}]{bar}[/{color}] {value:.2f}"


def confidence_bar(value: float, width: int = 20) -> str:
    filled = int(value * width)
    bar = "█" * filled + "░" * (width - filled)
    return f"[cyan]{bar}[/cyan] {value:.2f}"


async def show_beliefs():
    beliefs = await get_active_beliefs()
    table = Table(title="Active Beliefs", show_lines=True)
    table.add_column("#", style="dim", width=3)
    table.add_column("Belief", style="white", max_width=50)
    table.add_column("Domain", style="dim")
    table.add_column("Confidence", width=28)
    table.add_column("Tension", width=28)
    table.add_column("Importance", style="dim")

    for i, b in enumerate(beliefs):
        table.add_row(
            str(i),
            b.content,
            b.domain,
            confidence_bar(b.confidence),
            tension_bar(b.tension),
            f"{b.importance:.1f}",
        )
    console.print(table)


async def show_dissatisfaction():
    d = await compute_dissatisfaction()
    breakdown = await get_dissatisfaction_breakdown()

    console.print(Panel(
        f"[bold]Global Dissatisfaction: {tension_bar(d, 40)}[/bold]\n"
        f"State: {describe_state(d)}",
        title="🧠 Dissatisfaction Signal",
    ))

    if breakdown:
        table = Table(title="Per-Belief Contribution")
        table.add_column("Belief", max_width=40)
        table.add_column("Tension")
        table.add_column("Importance")
        table.add_column("Connections")
        table.add_column("Contribution", style="bold")
        for b in breakdown[:10]:
            table.add_row(
                b["content"][:40],
                f"{b['tension']:.2f}",
                f"{b['importance']:.1f}",
                str(b["connections"]),
                f"{b['contribution']:.3f}",
            )
        console.print(table)


async def show_revisions():
    revisions = await get_recent_revisions(limit=10)
    if not revisions:
        console.print("[dim]No revisions yet.[/dim]")
        return

    for r in revisions:
        console.print(Panel(
            f"[red]OLD:[/red] {r['old_content']}\n"
            f"[green]NEW:[/green] {r['new_content']}\n"
            f"[dim]Trigger tension: {r['trigger_tension']:.2f}[/dim]\n"
            f"[dim]Reasoning: {(r.get('reasoning') or '')[:200]}[/dim]",
            title=f"Revision — {r['created_at']}",
        ))


async def show_help():
    console.print(Panel(
        "[bold]Commands:[/bold]\n"
        "  [cyan]\\beliefs[/cyan]        — Show all active beliefs with tension levels\n"
        "  [cyan]\\graph[/cyan]          — Show belief graph with all connections\n"
        "  [cyan]\\dissatisfaction[/cyan] — Show global dissatisfaction breakdown\n"
        "  [cyan]\\revisions[/cyan]      — Show revision history\n"
        "  [cyan]\\seed[/cyan]           — Re-seed initial beliefs\n"
        "  [cyan]\\help[/cyan]           — Show this help\n"
        "  [cyan]\\quit[/cyan]           — Exit\n"
        "\n"
        "Anything else is sent as a chat message to the system.",
        title="Anxious Intelligence CLI",
    ))


async def show_graph():
    """Show the full belief graph with all connections."""
    from src.belief_graph import get_active_beliefs
    from src import db as _db

    beliefs = await get_active_beliefs()
    if not beliefs:
        console.print("[dim]No beliefs.[/dim]")
        return

    # Fetch all connections
    rows = await _db.fetch(
        """
        SELECT c.*, a.content as a_content, b.content as b_content
        FROM belief_connections c
        JOIN beliefs a ON c.belief_a = a.id
        JOIN beliefs b ON c.belief_b = b.id
        WHERE a.is_active = true AND b.is_active = true
        ORDER BY c.strength DESC
        """
    )

    console.print(f"\n[bold]Belief Graph[/bold] — {len(beliefs)} nodes, {len(rows)} edges\n")

    if rows:
        table = Table(show_lines=True)
        table.add_column("From", max_width=35)
        table.add_column("→", width=15)
        table.add_column("To", max_width=35)
        table.add_column("Str", width=5)
        for r in rows:
            rel_color = {
                "supports": "green",
                "contradicts": "red",
                "depends_on": "cyan",
                "generalizes": "yellow",
                "tension_shares": "magenta",
            }.get(r["relation"], "white")
            table.add_row(
                r["a_content"][:35],
                f"[{rel_color}]{r['relation']}[/{rel_color}]",
                r["b_content"][:35],
                f"{r['strength']:.1f}",
            )
        console.print(table)
    else:
        console.print("[dim]No connections yet. Connections emerge during revisions.[/dim]")


async def handle_revision(revision: dict):
    if revision.get("status") == "revised":
        console.print()

        # Connection discovery info
        stored = revision.get("stored_connections", 0)
        discovered = revision.get("discovered_connections", 0)
        disc_details = revision.get("discovered_details", [])

        conn_text = f"[cyan]Connections:[/cyan] {stored} stored, [bold yellow]{discovered} discovered[/bold yellow]"
        if disc_details:
            conn_text += "\n"
            for d in disc_details:
                conn_text += f"  [yellow]↗[/yellow] {d['content']} [{d['relation']}] — {d['reasoning']}\n"

        console.print(Panel(
            f"[bold red]⚡ BELIEF REVISION TRIGGERED[/bold red]\n\n"
            f"[red]Old:[/red] {revision.get('old_belief', '?')}\n"
            f"[green]New:[/green] {revision.get('new_belief', '?')}\n\n"
            f"[dim]Analysis: {revision.get('analysis', '')[:400]}[/dim]\n\n"
            f"{conn_text}\n"
            f"[yellow]Behavioral changes:[/yellow]\n" +
            "\n".join(f"  • {c}" for c in revision.get("behavioral_changes", [])),
            title="🔄 Phase Transition",
            border_style="red",
        ))
        console.print()


async def run_cli():
    console.print(Panel(
        "[bold]ANXIOUS INTELLIGENCE[/bold]\n"
        "A system for persistent dissonance-driven AI\n"
        "[dim]Type \\help for commands[/dim]",
        border_style="bright_blue",
    ))

    # Initialize
    pool = await get_pool()
    seeded = await seed_beliefs()
    if seeded:
        console.print("[green]✓ Seeded initial beliefs[/green]")
    else:
        count = len(await get_active_beliefs())
        console.print(f"[dim]✓ {count} active beliefs loaded[/dim]")

    d = await compute_dissatisfaction()
    console.print(f"[dim]Dissatisfaction: {d:.3f} — {describe_state(d)}[/dim]")
    console.print()

    session_id = str(uuid.uuid4())[:8]

    while True:
        try:
            user_input = console.input("[bold cyan]you>[/bold cyan] ").strip()
        except (EOFError, KeyboardInterrupt):
            break

        if not user_input:
            continue

        if user_input.startswith("\\"):
            cmd = user_input.lower().split()[0]
            if cmd in ("\\quit", "\\exit", "\\q"):
                break
            elif cmd == "\\beliefs":
                await show_beliefs()
            elif cmd in ("\\dissatisfaction", "\\d"):
                await show_dissatisfaction()
            elif cmd in ("\\graph", "\\g"):
                await show_graph()
            elif cmd in ("\\revisions", "\\rev"):
                await show_revisions()
            elif cmd == "\\seed":
                # Force re-seed
                from src import db as _db
                await _db.execute("DELETE FROM revisions")
                await _db.execute("DELETE FROM contradiction_log")
                await _db.execute("DELETE FROM interactions")
                await _db.execute("DELETE FROM belief_connections")
                await _db.execute("DELETE FROM beliefs")
                await seed_beliefs()
                console.print("[green]✓ Re-seeded beliefs[/green]")
            elif cmd == "\\help":
                await show_help()
            else:
                console.print(f"[red]Unknown command: {cmd}[/red]")
            continue

        # Process through the full orchestrator
        console.print("[dim]Processing...[/dim]")
        try:
            result = await process_interaction(
                user_message=user_input,
                session_id=session_id,
                on_revision=handle_revision,
            )

            # Show response
            console.print()
            console.print(Panel(
                result["response"],
                title="[bold]anxious_[/bold]",
                border_style="bright_blue",
            ))

            # Show state bar
            d = result["dissatisfaction"]
            ev = result["evidence_extracted"]
            state = result["dissatisfaction_state"]
            console.print(f"[dim]  📊 dissatisfaction={d:.3f} | evidence={ev} | {state}[/dim]")
            console.print()

        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")
            import traceback
            console.print(f"[dim]{traceback.format_exc()}[/dim]")

    await close_pool()
    console.print("[dim]Goodbye.[/dim]")


def main():
    asyncio.run(run_cli())


if __name__ == "__main__":
    main()
