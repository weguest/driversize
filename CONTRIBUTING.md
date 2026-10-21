# Contribuindo com o DriverSize

## Modelo de branches

Este repositório usa **trunk-based development / GitHub Flow**. Não existem branches
permanentes `dev` ou `hml`.

```text
main (protegida, sempre pronta para produção)
├─ feat/...
├─ fix/...
├─ chore/...
├─ docs/...
└─ release/x.y   (temporária, apenas durante congelamento para QA)
```

- `main` é a única branch permanente e deve estar sempre verde.
- Branches de trabalho são curtas e nascem da `main`.
- A promoção para produção é feita por **tag** `vX.Y.Z`, não por merge entre branches.
- `release/x.y` só é criada quando for necessário congelar uma versão para homologação.
- Tags são imutáveis; nunca reutilize uma tag já publicada.

## Fluxo normal

1. Atualize a `main`:

```powershell
git switch main
git pull
```

2. Crie a branch:

```powershell
git switch -c feat/nome-curto
```

3. Faça commits pequenos e abra um PR para `main`.
4. O workflow **CI** precisa passar.
5. Faça **squash merge** e apague a branch.
6. Para publicar uma versão:

```powershell
npm version patch
git push --follow-tags
```

A tag `vX.Y.Z` dispara o workflow **Release**, que compila o app e publica os
instaladores no GitHub Releases.

## Correções urgentes

1. Crie `fix/...` a partir da `main`.
2. Abra PR e faça o merge.
3. Gere uma tag de patch:

```powershell
npm version patch
git push --follow-tags
```

Se existir uma `release/x.y` congelada, aplique a correção nela, gere a tag e faça o
merge de volta na `main`.

## Versionamento

Use SemVer:

- `patch`: correções compatíveis;
- `minor`: funcionalidades compatíveis;
- `major`: mudanças incompatíveis.

A versão do `package.json` e a tag devem coincidir.

## CI e Release

- **CI** roda em todo PR e em push na `main`: instala dependências, compila Angular,
  compila o processo Electron e compila o módulo nativo.
- **Release** roda em tags `v*` ou por `workflow_dispatch`, usando o ambiente
  `production`.
- O workflow anexa `setup.exe`, `portable.exe`, `.blockmap` e `SHA256SUMS.txt`.

## O que não commitar

- `node_modules/`
- `dist/`
- `dist-electron/`
- `release/`
- `native/shellmenu/build/`
- `.env`, certificados, chaves de assinatura e tokens

## Assinatura de código

Para assinar o instalador, configure os secrets:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`

Nunca coloque o certificado no repositório.
