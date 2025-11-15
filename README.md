Debugging:

```
GTK_DEBUG=interactive ags run
ags inspect -i [config name, wam]
```

### Dev env install
Clone
```shell
git clone https://github.com/LeadSeason/wam-shell.git
```
Typescript types
```shell
ags types -d ./wam-shell
```
installing modules.
```shell
cd ./wam-shell
mkdir node_modules
ln -s /usr/share/ags/js node_modules/ags  
ln -s /usr/share/ags/js/node_modules/gnim node_modules/gnim
rm -f package-lock.json
npm i
```