# Regras de recursos para os agentes (leia antes de começar)

**Todo o trabalho pesado roda na VPS, nunca no notebook.** O notebook do dono do projeto tem só 16 GB. Em 17/10/2026, o Ubuntu fechou o terminal por falta de memória com 20 agentes compilando nele.

| Onde | O que fica lá |
|---|---|
| **VPS** (Debian 13, 8 núcleos, 31 GB) | O guia **de verdade**: `~/guia-git` (git), o laboratório `~/guia-git-lab/lab` (Ubuntu 26.04 + Git) e o Node 24. |
| **Notebook** | Só o seu rascunho (`SCRATCH/SEU-NOME/`) e o modelo de estrutura das páginas, para leitura: `~/guia-c` (estrutura de guia irmão). |

## Os comandos (rodam no notebook, o trabalho acontece na VPS)
| Comando | O que faz |
|---|---|
| `~/guia-c-lab/vps 'comando'` | Roda um comando na VPS (a pasta inicial é a home da VPS). Ex.: `~/guia-c-lab/vps 'cat ~/guia-git/CONTRIBUINDO.md'` |
| `~/guia-c-lab/vps 'timeout 120 ~/guia-git-lab/lab -n SEU-NOME -i' < cmds.txt` | Laboratório da Ana (o stdin passa pelo ssh). |
| `~/guia-git-lab/enviar SCRATCH/SEU-NOME/pagina.html` | Copia a página para `~/guia-git/` na VPS. |
| `~/guia-git-lab/testar [--nativo] pagina.html` | Testador de missões na VPS (`timeout` incluso). Só existe depois que o agente do simulador entregar o testador. |

## Fluxo de uma página
1. Escreva e edite a página **no rascunho**: `SCRATCH/SEU-NOME/pagina.html`, com Write/Edit.
2. Rode as saídas reais no lab da VPS.
3. Mande a página com `enviar` e teste com `testar`.
4. Faça o commit **na VPS**, só dos seus arquivos:
   ```bash
   ~/guia-c-lab/vps 'cd ~/guia-git && git add pagina.html && git commit -q -m "pagina: aula nova" -- pagina.html'
   ```
   - Faça um commit a cada página pronta.
   - Nunca use `git add -A`, `commit -a`, `stash`, `reset`, `checkout -- .`, `rebase` ou `push`.
   - Se der `index.lock`, espere 2 s e tente de novo.

## Regras
1. **No notebook, nada pesado:** nada de `node` nem Chromium. Lá, só ler, escrever no rascunho, usar `ssh`/`scp`, `grep` e `sed`.
2. **Na VPS:** um processo pesado por vez, por agente, e sempre com `timeout`.
3. **Sem subagentes.**
4. **Nunca use `pkill` ou `killall`**, nem na VPS (lá rodam outros serviços do dono). Use `kill %1` ou `kill $!`.
5. **Lab com o seu nome:** `-n SEU-NOME`.
6. **Não edite arquivos dos outros:** `assets/`, `tools/`, `CONTRIBUINDO.md`, `RECURSOS.md` e as páginas de outros autores. Achou um problema? Anote no fim do seu relatório.
7. **Nada da máquina real nas páginas:**
   - nenhum caminho de pasta, nome de máquina ou IP do notebook do dono ou da VPS;
   - nenhum nome real, fuso real, MAC ou IP real;
   - só a Ana: `/home/ana` e `notebook`.
