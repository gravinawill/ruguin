# Fluxo de branches (Git Flow)

Este repositório usa [Git Flow](https://nvie.com/posts/a-successful-git-branching-model/). Inicializado com `git flow init` (prefixos padrão), config em `.git/config` (`[gitflow]`).

## Branches base

- `master` — produção. Todo commit em `master` é releasable; releases e hotfixes são taggeados a partir daqui.
- `develop` — integração. Ponto de partida para todo trabalho novo; features e bugfixes são mergeados aqui antes de seguir para uma release.

## Branches de trabalho

| Tipo    | Prefixo    | Nasce de  | Volta para           | Uso                                                                      |
| ------- | ---------- | --------- | -------------------- | ------------------------------------------------------------------------ |
| Feature | `feature/` | `develop` | `develop`            | Trabalho novo, sem urgência de release                                   |
| Bugfix  | `bugfix/`  | `develop` | `develop`            | Correção de bug ainda não lançado                                        |
| Release | `release/` | `develop` | `master` + `develop` | Estabilização antes de lançar (versionamento, changelog, ajustes finais) |
| Hotfix  | `hotfix/`  | `master`  | `master` + `develop` | Correção urgente direto em produção                                      |
| Support | `support/` | `master`  | —                    | Manutenção de uma versão antiga em paralelo                              |

## Comandos

```bash
git flow feature start nome-da-feature   # cria feature/nome-da-feature a partir de develop
git flow feature finish nome-da-feature  # merge de volta em develop

git flow hotfix start nome-do-hotfix     # cria hotfix/nome-do-hotfix a partir de master
git flow hotfix finish nome-do-hotfix    # merge em master e develop, com tag

git flow release start 1.2.0             # cria release/1.2.0 a partir de develop
git flow release finish 1.2.0            # merge em master e develop, com tag
```

Sem a ferramenta `git-flow`, os mesmos fluxos funcionam com `git checkout -b`/`git merge` manual, seguindo a mesma tabela de origem/destino acima.

## CI

`ci.yml` e `security.yml` rodam em push/PR para `master` e `develop`.
